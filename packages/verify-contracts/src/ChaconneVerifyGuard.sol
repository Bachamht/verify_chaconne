// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title ChaconneVerifyGuard
/// @notice Constrains one exactIn stablecoin→stock-token purchase on X Layer to a user-signed TradeIntent and a
///         service-signed VerificationCertificate (Chaconne Verify, Dev Day 2026, D-080 / 技术设计 §9).
/// @dev Trust model (stated, not hidden):
///      - The contract enforces amounts, recipient, router/spender/selector allowlists, calldata hash, deadlines,
///        nonces and signer epochs. It does NOT know whether off-chain stock reference data was correct — that is
///        the attestation service's judgement, bound to the intent via `evidenceHash` / policy hashes.
///      - The owner (deployer admin) can pause, rotate the attestation signer (by epoch), and edit allowlists. The
///        owner can never move user funds: there is no arbitrary call, no delegatecall, no sweep of user tokens.
///      - Guard holds no long-lived balances; any tokens donated to it are not attributable and are ignored by the
///        balance-delta accounting (they can only be swept by the owner via `rescue`, never as user output/refund).
contract ChaconneVerifyGuard is EIP712, ReentrancyGuard, Pausable, Ownable2Step {
    using SafeERC20 for IERC20;

    /* ---------------------------------------------------------------------- */
    /*                                 Types                                  */
    /* ---------------------------------------------------------------------- */

    /// @dev Field order is frozen and mirrors packages/core/src/verify/eip712.ts.
    struct TradeIntent {
        address owner;
        address recipient;
        address inputToken;
        address outputToken;
        uint256 amountIn;
        uint256 minAmountOut;
        address router;
        address spender;
        bytes32 calldataHash;
        bytes32 policyDefinitionHash;
        bytes32 effectivePolicyHash;
        bytes32 registryHash;
        bytes32 evidenceHash;
        uint256 nonce;
        uint64 deadline;
    }

    struct VerificationCertificate {
        bytes32 intentDigest;
        bytes32 evidenceHash;
        bytes32 policyDefinitionHash;
        bytes32 effectivePolicyHash;
        uint64 issuedAt;
        uint64 validUntil;
        uint64 signerEpoch;
    }

    bytes32 public constant TRADE_INTENT_TYPEHASH = keccak256(
        "TradeIntent(address owner,address recipient,address inputToken,address outputToken,uint256 amountIn,uint256 minAmountOut,address router,address spender,bytes32 calldataHash,bytes32 policyDefinitionHash,bytes32 effectivePolicyHash,bytes32 registryHash,bytes32 evidenceHash,uint256 nonce,uint64 deadline)"
    );

    bytes32 public constant VERIFICATION_CERTIFICATE_TYPEHASH = keccak256(
        "VerificationCertificate(bytes32 intentDigest,bytes32 evidenceHash,bytes32 policyDefinitionHash,bytes32 effectivePolicyHash,uint64 issuedAt,uint64 validUntil,uint64 signerEpoch)"
    );

    /* ---------------------------------------------------------------------- */
    /*                                 Storage                                */
    /* ---------------------------------------------------------------------- */

    /// @notice attestation signer per epoch; address(0) = epoch disabled
    mapping(uint64 => address) public signerOfEpoch;
    /// @notice epochs currently accepted
    mapping(uint64 => bool) public epochEnabled;
    /// @notice enabled policy definitions (policyDefinitionHash → enabled)
    mapping(bytes32 => bool) public policyEnabled;
    /// @notice enabled asset registries (registryHash → enabled)
    mapping(bytes32 => bool) public registryEnabled;
    /// @notice allowed (router, spender) pairs
    mapping(address => mapping(address => bool)) public routeEnabled;
    /// @notice allowed function selectors per router
    mapping(address => mapping(bytes4 => bool)) public selectorEnabled;
    /// @notice tokens that may appear as input/output
    mapping(address => bool) public tokenEnabled;
    /// @notice consumed / cancelled nonces per owner
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    /// @notice hard cap on certificate lifetime (validUntil - issuedAt)
    uint64 public maxCertificateTtl;

    /* ---------------------------------------------------------------------- */
    /*                                 Events                                 */
    /* ---------------------------------------------------------------------- */

    event GuardedExecution(
        address indexed owner,
        address indexed recipient,
        uint256 indexed nonce,
        bytes32 intentDigest,
        bytes32 evidenceHash,
        bytes32 policyDefinitionHash,
        bytes32 effectivePolicyHash,
        address router,
        uint256 amountIn,
        uint256 spent,
        uint256 received,
        uint256 refunded
    );
    event NonceCancelled(address indexed owner, uint256 indexed nonce);
    event SignerEpochSet(uint64 indexed epoch, address signer, bool enabled);
    event PolicySet(bytes32 indexed policyDefinitionHash, bool enabled);
    event RegistrySet(bytes32 indexed registryHash, bool enabled);
    event RouteSet(address indexed router, address indexed spender, bool enabled);
    event SelectorSet(address indexed router, bytes4 indexed selector, bool enabled);
    event TokenSet(address indexed token, bool enabled);
    event MaxCertificateTtlSet(uint64 ttl);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    /* ---------------------------------------------------------------------- */
    /*                                 Errors                                 */
    /* ---------------------------------------------------------------------- */

    error NotOwnerOfIntent();
    error IntentExpired();
    error CertificateNotYetValid();
    error CertificateExpired();
    error CertificateOutlivesIntent();
    error CertificateTtlTooLong();
    error CertificateIntentMismatch();
    error CertificateBindingMismatch();
    error InvalidIntentSignature();
    error InvalidCertificateSignature();
    error EpochDisabled();
    error PolicyDisabled();
    error RegistryDisabled();
    error RouteNotAllowed();
    error SelectorNotAllowed();
    error TokenNotAllowed();
    error CalldataMismatch();
    error NonceAlreadyUsed();
    error ZeroAddress();
    error ZeroAmount();
    error InputTransferShortfall();
    error RouterCallFailed(bytes reason);
    error OverSpent();
    error InsufficientOutput(uint256 received, uint256 minAmountOut);
    error RecipientShortfall();
    error SameToken();

    /* ---------------------------------------------------------------------- */
    /*                               Constructor                              */
    /* ---------------------------------------------------------------------- */

    constructor(address initialOwner, address initialSigner, uint64 initialEpoch, uint64 maxCertTtl)
        EIP712("ChaconneVerifyGuard", "1")
        Ownable(initialOwner)
    {
        if (initialSigner == address(0)) revert ZeroAddress();
        signerOfEpoch[initialEpoch] = initialSigner;
        epochEnabled[initialEpoch] = true;
        maxCertificateTtl = maxCertTtl;
        emit SignerEpochSet(initialEpoch, initialSigner, true);
        emit MaxCertificateTtlSet(maxCertTtl);
    }

    /* ---------------------------------------------------------------------- */
    /*                                  Admin                                 */
    /* ---------------------------------------------------------------------- */

    function setSignerEpoch(uint64 epoch, address signer, bool enabled) external onlyOwner {
        if (enabled && signer == address(0)) revert ZeroAddress();
        signerOfEpoch[epoch] = signer;
        epochEnabled[epoch] = enabled;
        emit SignerEpochSet(epoch, signer, enabled);
    }

    function setPolicy(bytes32 policyDefinitionHash, bool enabled) external onlyOwner {
        policyEnabled[policyDefinitionHash] = enabled;
        emit PolicySet(policyDefinitionHash, enabled);
    }

    function setRegistry(bytes32 registryHash, bool enabled) external onlyOwner {
        registryEnabled[registryHash] = enabled;
        emit RegistrySet(registryHash, enabled);
    }

    function setRoute(address router, address spender, bool enabled) external onlyOwner {
        if (router == address(0) || spender == address(0)) revert ZeroAddress();
        routeEnabled[router][spender] = enabled;
        emit RouteSet(router, spender, enabled);
    }

    function setSelector(address router, bytes4 selector, bool enabled) external onlyOwner {
        selectorEnabled[router][selector] = enabled;
        emit SelectorSet(router, selector, enabled);
    }

    function setToken(address token, bool enabled) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        tokenEnabled[token] = enabled;
        emit TokenSet(token, enabled);
    }

    function setMaxCertificateTtl(uint64 ttl) external onlyOwner {
        maxCertificateTtl = ttl;
        emit MaxCertificateTtlSet(ttl);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Sweep tokens that were donated / stranded in the Guard. Never callable mid-execution and never
    ///         counted as a user's output or refund (balance-delta accounting only attributes in-tx changes).
    function rescue(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    /* ---------------------------------------------------------------------- */
    /*                                  User                                  */
    /* ---------------------------------------------------------------------- */

    /// @notice Cancel a nonce so any certificate/intent already signed for it can never execute.
    function cancelNonce(uint256 nonce) external {
        if (nonceUsed[msg.sender][nonce]) revert NonceAlreadyUsed();
        nonceUsed[msg.sender][nonce] = true;
        emit NonceCancelled(msg.sender, nonce);
    }

    /* ---------------------------------------------------------------------- */
    /*                                Hashing                                 */
    /* ---------------------------------------------------------------------- */

    function hashIntent(TradeIntent calldata intent) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TRADE_INTENT_TYPEHASH,
                intent.owner,
                intent.recipient,
                intent.inputToken,
                intent.outputToken,
                intent.amountIn,
                intent.minAmountOut,
                intent.router,
                intent.spender,
                intent.calldataHash,
                intent.policyDefinitionHash,
                intent.effectivePolicyHash,
                intent.registryHash,
                intent.evidenceHash,
                intent.nonce,
                intent.deadline
            )
        );
    }

    function hashCertificate(VerificationCertificate calldata cert) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                VERIFICATION_CERTIFICATE_TYPEHASH,
                cert.intentDigest,
                cert.evidenceHash,
                cert.policyDefinitionHash,
                cert.effectivePolicyHash,
                cert.issuedAt,
                cert.validUntil,
                cert.signerEpoch
            )
        );
    }

    function intentDigest(TradeIntent calldata intent) public view returns (bytes32) {
        return _hashTypedDataV4(hashIntent(intent));
    }

    function certificateDigest(VerificationCertificate calldata cert) public view returns (bytes32) {
        return _hashTypedDataV4(hashCertificate(cert));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /* ---------------------------------------------------------------------- */
    /*                                Execute                                 */
    /* ---------------------------------------------------------------------- */

    /// @notice Execute one verified exactIn purchase. Reverts entirely on any violated bound; never partially settles.
    /// @return spent     input actually consumed by the router
    /// @return received  output delivered to `recipient` (measured on the recipient's balance)
    /// @return refunded  unconsumed input returned to `owner`
    function execute(
        TradeIntent calldata intent,
        bytes calldata intentSignature,
        VerificationCertificate calldata cert,
        bytes calldata certSignature,
        bytes calldata routerCalldata
    ) external nonReentrant whenNotPaused returns (uint256 spent, uint256 received, uint256 refunded) {
        _checkIntentAndCertificate(intent, intentSignature, cert, certSignature, routerCalldata);

        // ---- consume nonce before any external call ----
        nonceUsed[intent.owner][intent.nonce] = true;

        (spent, received, refunded) = _pullSwapSettle(intent, routerCalldata);

        emit GuardedExecution(
            intent.owner,
            intent.recipient,
            intent.nonce,
            cert.intentDigest,
            intent.evidenceHash,
            intent.policyDefinitionHash,
            intent.effectivePolicyHash,
            intent.router,
            intent.amountIn,
            spent,
            received,
            refunded
        );
    }

    /// @dev Pull exact input → single-use allowance → router call → attribute this-tx balance deltas → settle.
    function _pullSwapSettle(TradeIntent calldata intent, bytes calldata routerCalldata)
        internal
        returns (uint256 spent, uint256 received, uint256 refunded)
    {
        IERC20 inputToken = IERC20(intent.inputToken);
        IERC20 outputToken = IERC20(intent.outputToken);

        uint256 inputBefore = inputToken.balanceOf(address(this));
        uint256 outputBefore = outputToken.balanceOf(address(this));

        // reject fee-on-transfer / rebasing-on-transfer input tokens
        inputToken.safeTransferFrom(intent.owner, address(this), intent.amountIn);
        if (inputToken.balanceOf(address(this)) - inputBefore != intent.amountIn) revert InputTransferShortfall();

        inputToken.forceApprove(intent.spender, intent.amountIn);
        (bool ok, bytes memory ret) = intent.router.call{value: 0}(routerCalldata);
        if (!ok) revert RouterCallFailed(ret);
        inputToken.forceApprove(intent.spender, 0);

        uint256 inputLeft = inputToken.balanceOf(address(this)) - inputBefore;
        if (inputLeft > intent.amountIn) revert OverSpent();
        spent = intent.amountIn - inputLeft;
        received = outputToken.balanceOf(address(this)) - outputBefore;
        if (received < intent.minAmountOut) revert InsufficientOutput(received, intent.minAmountOut);
        refunded = inputLeft;

        if (refunded > 0) inputToken.safeTransfer(intent.owner, refunded);
        uint256 recipientBefore = outputToken.balanceOf(intent.recipient);
        outputToken.safeTransfer(intent.recipient, received);
        if (outputToken.balanceOf(intent.recipient) - recipientBefore < intent.minAmountOut) revert RecipientShortfall();
    }

    function _checkIntentAndCertificate(
        TradeIntent calldata intent,
        bytes calldata intentSignature,
        VerificationCertificate calldata cert,
        bytes calldata certSignature,
        bytes calldata routerCalldata
    ) internal view {
        if (msg.sender != intent.owner) revert NotOwnerOfIntent();
        if (intent.recipient == address(0)) revert ZeroAddress();
        if (intent.amountIn == 0 || intent.minAmountOut == 0) revert ZeroAmount();
        if (intent.inputToken == intent.outputToken) revert SameToken();
        if (block.timestamp > intent.deadline) revert IntentExpired();
        if (block.timestamp < cert.issuedAt) revert CertificateNotYetValid();
        if (block.timestamp > cert.validUntil) revert CertificateExpired();
        if (cert.validUntil > intent.deadline) revert CertificateOutlivesIntent();
        if (cert.validUntil - cert.issuedAt > maxCertificateTtl) revert CertificateTtlTooLong();
        if (nonceUsed[intent.owner][intent.nonce]) revert NonceAlreadyUsed();

        // ---- allowlists ----
        if (!policyEnabled[intent.policyDefinitionHash]) revert PolicyDisabled();
        if (!registryEnabled[intent.registryHash]) revert RegistryDisabled();
        if (!routeEnabled[intent.router][intent.spender]) revert RouteNotAllowed();
        if (!tokenEnabled[intent.inputToken] || !tokenEnabled[intent.outputToken]) revert TokenNotAllowed();
        if (routerCalldata.length < 4 || !selectorEnabled[intent.router][bytes4(routerCalldata[:4])]) revert SelectorNotAllowed();
        if (keccak256(routerCalldata) != intent.calldataHash) revert CalldataMismatch();

        // ---- binding: certificate ↔ intent ----
        bytes32 digest = _hashTypedDataV4(hashIntent(intent));
        if (cert.intentDigest != digest) revert CertificateIntentMismatch();
        if (
            cert.evidenceHash != intent.evidenceHash || cert.policyDefinitionHash != intent.policyDefinitionHash
                || cert.effectivePolicyHash != intent.effectivePolicyHash
        ) revert CertificateBindingMismatch();

        // ---- signatures ----
        (address intentSigner, ECDSA.RecoverError err1,) = ECDSA.tryRecover(digest, intentSignature);
        if (err1 != ECDSA.RecoverError.NoError || intentSigner != intent.owner) revert InvalidIntentSignature();

        if (!epochEnabled[cert.signerEpoch]) revert EpochDisabled();
        address expectedSigner = signerOfEpoch[cert.signerEpoch];
        (address certSigner, ECDSA.RecoverError err2,) =
            ECDSA.tryRecover(_hashTypedDataV4(hashCertificate(cert)), certSignature);
        if (err2 != ECDSA.RecoverError.NoError || certSigner == address(0) || certSigner != expectedSigner) {
            revert InvalidCertificateSignature();
        }
    }
}
