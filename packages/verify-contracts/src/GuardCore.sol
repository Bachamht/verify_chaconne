// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title GuardCore
/// @notice Shared execution core for Chaconne Verify guards (v2, extracted from the deployed v1
///         `ChaconneVerifyGuard`, whose source is intentionally left untouched).
/// @dev What lives here (all of it enforced on-chain, none of it trusting the router or the service):
///      - allowlists: policy definition hashes, registry hashes, (router, spender) pairs, per-router function
///        selectors, tokens; attestation signer per epoch; pause; Ownable2Step admin; `rescue` for stranded tokens;
///      - `_pullSwapSettle`: pull input from the owner, grant a single-use exact allowance to the spender, call the
///        router with the exact calldata the certificate binds, attribute ONLY this-transaction balance deltas,
///        enforce the absolute `minAmountOut`, refund unconsumed input to the owner, deliver output to the recipient.
///      Trust boundary (stated, not hidden): the admin can pause, rotate the signer epoch and edit allowlists; the
///      admin can never move user funds (no arbitrary call, no delegatecall, no sweep of in-flight balances).
///      Donated / stranded balances are never attributed to a user; only the admin can `rescue` them.
abstract contract GuardCore is ReentrancyGuard, Pausable, Ownable2Step {
    using SafeERC20 for IERC20;

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
    /// @notice hard cap on certificate lifetime (validUntil - issuedAt)
    uint64 public maxCertificateTtl;
    /// @notice tolerated shortfall (wei) when pulling `token` as INPUT: rebasing share tokens (xStocks EVM) may
    ///         deliver 1 wei less than requested because of share rounding (CV-D05 reverse case). Default 0 =
    ///         exact transfer required (fee-on-transfer tokens stay rejected).
    mapping(address => uint256) public inputShortfallTolerance;

    /* ---------------------------------------------------------------------- */
    /*                                 Events                                 */
    /* ---------------------------------------------------------------------- */

    event SignerEpochSet(uint64 indexed epoch, address signer, bool enabled);
    event PolicySet(bytes32 indexed policyDefinitionHash, bool enabled);
    event RegistrySet(bytes32 indexed registryHash, bool enabled);
    event RouteSet(address indexed router, address indexed spender, bool enabled);
    event SelectorSet(address indexed router, bytes4 indexed selector, bool enabled);
    event TokenSet(address indexed token, bool enabled);
    event MaxCertificateTtlSet(uint64 ttl);
    event InputShortfallToleranceSet(address indexed token, uint256 tolerance);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    /* ---------------------------------------------------------------------- */
    /*                                 Errors                                 */
    /* ---------------------------------------------------------------------- */

    error CertificateNotYetValid();
    error CertificateExpired();
    error CertificateTtlTooLong();
    error InvalidCertificateSignature();
    error EpochDisabled();
    error PolicyDisabled();
    error RegistryDisabled();
    error RouteNotAllowed();
    error SelectorNotAllowed();
    error TokenNotAllowed();
    error CalldataMismatch();
    error ZeroAddress();
    error ZeroAmount();
    error InputTransferShortfall();
    error InputTransferExcess();
    error RouterCallFailed(bytes reason);
    error OverSpent();
    error InsufficientOutput(uint256 received, uint256 minAmountOut);
    error RecipientShortfall();
    error SameToken();
    error NonZeroValue();

    /* ---------------------------------------------------------------------- */
    /*                               Constructor                              */
    /* ---------------------------------------------------------------------- */

    constructor(address initialOwner, address initialSigner, uint64 initialEpoch, uint64 maxCertTtl)
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

    /// @notice Allow `token` (as INPUT) to arrive up to `tolerance` wei short of the requested amount.
    ///         Meant for registered rebasing stock tokens only (1e6 wei ≈ 1e-12 shares); never for stablecoins.
    function setInputShortfallTolerance(address token, uint256 tolerance) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        inputShortfallTolerance[token] = tolerance;
        emit InputShortfallToleranceSet(token, tolerance);
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
    /*                           Shared static checks                         */
    /* ---------------------------------------------------------------------- */

    /// @dev Allowlist + calldata-hash checks common to every guarded execution.
    function _checkRouteAndTokens(
        address inputToken,
        address outputToken,
        address router,
        address spender,
        bytes32 calldataHash,
        bytes32 policyDefinitionHash,
        bytes32 registryHash,
        bytes calldata routerCalldata
    ) internal view {
        if (inputToken == outputToken) revert SameToken();
        if (!policyEnabled[policyDefinitionHash]) revert PolicyDisabled();
        if (!registryEnabled[registryHash]) revert RegistryDisabled();
        if (!routeEnabled[router][spender]) revert RouteNotAllowed();
        if (!tokenEnabled[inputToken] || !tokenEnabled[outputToken]) revert TokenNotAllowed();
        if (routerCalldata.length < 4 || !selectorEnabled[router][bytes4(routerCalldata[:4])]) {
            revert SelectorNotAllowed();
        }
        if (keccak256(routerCalldata) != calldataHash) revert CalldataMismatch();
    }

    /// @dev Certificate time window + signer epoch. `digest` is the EIP-712 digest of the certificate.
    function _checkCertificateWindowAndSigner(
        uint64 issuedAt,
        uint64 validUntil,
        uint64 signerEpoch,
        bytes32 digest,
        bytes calldata certSignature
    ) internal view {
        if (block.timestamp < issuedAt) revert CertificateNotYetValid();
        if (block.timestamp > validUntil) revert CertificateExpired();
        if (validUntil - issuedAt > maxCertificateTtl) revert CertificateTtlTooLong();
        if (!epochEnabled[signerEpoch]) revert EpochDisabled();
        address expectedSigner = signerOfEpoch[signerEpoch];
        (address certSigner, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, certSignature);
        if (err != ECDSA.RecoverError.NoError || certSigner == address(0) || certSigner != expectedSigner) {
            revert InvalidCertificateSignature();
        }
    }

    /* ---------------------------------------------------------------------- */
    /*                          Shared execution core                         */
    /* ---------------------------------------------------------------------- */

    struct SwapParams {
        address owner;
        address recipient;
        address inputToken;
        address outputToken;
        uint256 amountIn;
        uint256 minAmountOut;
        address router;
        address spender;
    }

    /// @dev Pull input → single-use allowance → router call → attribute this-tx balance deltas → settle.
    /// @return pulled    input actually received from the owner (== amountIn unless a tolerance applies)
    /// @return spent     input actually consumed by the router
    /// @return received  output delivered to `recipient` (measured on the Guard's own delta)
    /// @return refunded  unconsumed input returned to `owner`
    function _pullSwapSettle(SwapParams memory p, bytes calldata routerCalldata)
        internal
        returns (uint256 pulled, uint256 spent, uint256 received, uint256 refunded)
    {
        IERC20 inputToken = IERC20(p.inputToken);
        IERC20 outputToken = IERC20(p.outputToken);

        uint256 inputBefore = inputToken.balanceOf(address(this));
        uint256 outputBefore = outputToken.balanceOf(address(this));

        // pull; reject fee-on-transfer input, tolerate registered rebasing rounding only
        inputToken.safeTransferFrom(p.owner, address(this), p.amountIn);
        pulled = inputToken.balanceOf(address(this)) - inputBefore;
        if (pulled > p.amountIn) revert InputTransferExcess();
        if (pulled + inputShortfallTolerance[p.inputToken] < p.amountIn) revert InputTransferShortfall();

        inputToken.forceApprove(p.spender, pulled);
        (bool ok, bytes memory ret) = p.router.call{value: 0}(routerCalldata);
        if (!ok) revert RouterCallFailed(ret);
        inputToken.forceApprove(p.spender, 0);

        uint256 inputAfter = inputToken.balanceOf(address(this));
        if (inputAfter < inputBefore) revert OverSpent(); // router touched non-attributable balance
        uint256 inputLeft = inputAfter - inputBefore;
        if (inputLeft > pulled) revert OverSpent();
        spent = pulled - inputLeft;
        received = outputToken.balanceOf(address(this)) - outputBefore;
        if (received < p.minAmountOut) revert InsufficientOutput(received, p.minAmountOut);
        refunded = inputLeft;

        if (refunded > 0) inputToken.safeTransfer(p.owner, refunded);
        uint256 recipientBefore = outputToken.balanceOf(p.recipient);
        outputToken.safeTransfer(p.recipient, received);
        if (outputToken.balanceOf(p.recipient) - recipientBefore < p.minAmountOut) revert RecipientShortfall();
    }
}

