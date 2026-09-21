// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {GuardCore} from "./GuardCore.sol";

/// @title ChaconneVerifyPlanGuard (v2)
/// @notice Lets a user sign ONE `TradeMandate` (budget cap, per-step cap, step count, output-token set, policy /
///         registry hashes, time window) and then have any executor submit verified steps against it: each step
///         carries a service-signed `StepCertificate` bound to fresh evidence. Chaconne Verify, Dev Day 2026 (v5 W2).
/// @dev Trust model (stated, not hidden):
///      - The contract enforces: mandate signature (EOA, ECDSA), budget/per-step/step-count caps, strict step order
///        (stepIndex == steps executed → no replay, no double execution), time windows, output-token membership,
///        policy/registry allowlists, calldata hash, router/spender/selector/token allowlists, absolute minAmountOut,
///        refund of unconsumed input to the owner, delivery of output to the recipient.
///      - It does NOT know whether the off-chain evidence was correct — that is the attestation signer's judgement,
///        bound via `evidenceHash` / policy hashes inside the certificate the signer signs per step.
///      - Executor is permissionless (D-081): anyone may submit a valid (mandate, step, certificate) triple. The
///        executor pays gas and can never receive assets: output goes to `recipient`, refunds go to `owner`.
///      - Output-set membership uses a sorted-list commitment: the mandate commits to
///        `keccak256(abi.encodePacked(sortedUniqueOutputTokens))`; the executor passes the full sorted list, the
///        contract re-hashes it, checks strict ascending order (which also proves uniqueness), and scans it for
///        `step.outputToken`. No Merkle proofs: sets are tiny (≤ a handful of tokens).
///      - Mandate nonces live in their own namespace (`mandateNonceUsed`), separate from v1 intent nonces, and are
///        bound at step 0. `cancelMandateNonce` blocks a mandate that has not started; `revokeMandate` stops one
///        that has (owner only). Admin can pause, rotate the signer epoch and edit allowlists; admin can never move
///        user funds.
contract ChaconneVerifyPlanGuard is EIP712, GuardCore {
    /* ---------------------------------------------------------------------- */
    /*                                 Types                                  */
    /* ---------------------------------------------------------------------- */

    /// @dev Field order is frozen and mirrors packages/core/src/verify/eip712.ts (v2 section).
    struct TradeMandate {
        address owner;
        address recipient;
        address inputToken; // buy: stablecoin; sell: stock token
        bytes32 outputSetHash; // keccak256(abi.encodePacked(sorted unique outputTokens))
        uint256 budgetCap; // cumulative max input pulled under this mandate
        uint256 perStepCap;
        uint32 maxSteps;
        bytes32 policyDefinitionHash;
        bytes32 effectivePolicyHash;
        bytes32 registryHash;
        uint64 validFrom;
        uint64 deadline;
        uint256 nonce; // owner-scoped, mandate namespace
    }

    /// @dev Named `Step` in Solidity only because the frozen event is also called `MandateStep`; ABI tuples carry no struct names.
    struct Step {
        bytes32 mandateDigest;
        uint32 stepIndex;
        address outputToken;
        uint256 amountIn;
        uint256 minAmountOut;
        address router;
        address spender;
        bytes32 calldataHash;
        bytes32 evidenceHash;
        uint64 deadline;
    }

    struct StepCertificate {
        bytes32 stepDigest;
        bytes32 evidenceHash;
        bytes32 policyDefinitionHash;
        bytes32 effectivePolicyHash;
        uint64 issuedAt;
        uint64 validUntil;
        uint64 signerEpoch;
    }

    struct MandateState {
        uint256 spent;
        uint32 steps;
        bool revoked;
    }

    bytes32 public constant TRADE_MANDATE_TYPEHASH = keccak256(
        "TradeMandate(address owner,address recipient,address inputToken,bytes32 outputSetHash,uint256 budgetCap,uint256 perStepCap,uint32 maxSteps,bytes32 policyDefinitionHash,bytes32 effectivePolicyHash,bytes32 registryHash,uint64 validFrom,uint64 deadline,uint256 nonce)"
    );
    bytes32 public constant MANDATE_STEP_TYPEHASH = keccak256(
        "MandateStep(bytes32 mandateDigest,uint32 stepIndex,address outputToken,uint256 amountIn,uint256 minAmountOut,address router,address spender,bytes32 calldataHash,bytes32 evidenceHash,uint64 deadline)"
    );
    bytes32 public constant STEP_CERTIFICATE_TYPEHASH = keccak256(
        "StepCertificate(bytes32 stepDigest,bytes32 evidenceHash,bytes32 policyDefinitionHash,bytes32 effectivePolicyHash,uint64 issuedAt,uint64 validUntil,uint64 signerEpoch)"
    );

    /* ---------------------------------------------------------------------- */
    /*                                 Storage                                */
    /* ---------------------------------------------------------------------- */

    /// @notice per-mandate progress (keyed by mandate digest)
    mapping(bytes32 => MandateState) internal _mandates;
    /// @notice mandate nonces consumed (bound at step 0) or cancelled, per owner
    mapping(address => mapping(uint256 => bool)) public mandateNonceUsed;
    /// @notice which mandate digest bound a (owner, nonce); zero = cancelled without binding
    mapping(address => mapping(uint256 => bytes32)) public mandateOfNonce;

    /* ---------------------------------------------------------------------- */
    /*                                 Events                                 */
    /* ---------------------------------------------------------------------- */

    event MandateStep(
        address indexed owner,
        bytes32 indexed mandateDigest,
        uint32 indexed stepIndex,
        address outputToken,
        uint256 amountIn,
        uint256 spent,
        uint256 received,
        uint256 refunded,
        bytes32 evidenceHash,
        address executor
    );
    event MandateRevoked(address indexed owner, bytes32 indexed mandateDigest);
    event MandateNonceCancelled(address indexed owner, uint256 indexed nonce);

    /* ---------------------------------------------------------------------- */
    /*                                 Errors                                 */
    /* ---------------------------------------------------------------------- */

    error InvalidMandateSignature();
    error MandateRevokedError();
    error MandateNotYetValid();
    error MandateExpired();
    error StepExpired();
    error CertificateOutlivesStep();
    error StepOutOfOrder(uint32 expected, uint32 given);
    error StepsExhausted();
    error PerStepCapExceeded();
    error BudgetExceeded();
    error OutputSetMismatch();
    error OutputSetNotSorted();
    error OutputNotInSet();
    error StepMandateMismatch();
    error CertificateStepMismatch();
    error CertificateBindingMismatch();
    error MandateNonceAlreadyUsed();
    error NotMandateOwner();

    /* ---------------------------------------------------------------------- */
    /*                               Constructor                              */
    /* ---------------------------------------------------------------------- */

    constructor(address initialOwner, address initialSigner, uint64 initialEpoch, uint64 maxCertTtl)
        EIP712("ChaconneVerifyPlanGuard", "1")
        GuardCore(initialOwner, initialSigner, initialEpoch, maxCertTtl)
    {}

    /* ---------------------------------------------------------------------- */
    /*                                Hashing                                 */
    /* ---------------------------------------------------------------------- */

    function hashMandate(TradeMandate calldata m) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TRADE_MANDATE_TYPEHASH,
                m.owner,
                m.recipient,
                m.inputToken,
                m.outputSetHash,
                m.budgetCap,
                m.perStepCap,
                m.maxSteps,
                m.policyDefinitionHash,
                m.effectivePolicyHash,
                m.registryHash,
                m.validFrom,
                m.deadline,
                m.nonce
            )
        );
    }

    function hashStep(Step calldata s) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MANDATE_STEP_TYPEHASH,
                s.mandateDigest,
                s.stepIndex,
                s.outputToken,
                s.amountIn,
                s.minAmountOut,
                s.router,
                s.spender,
                s.calldataHash,
                s.evidenceHash,
                s.deadline
            )
        );
    }

    function hashCertificate(StepCertificate calldata c) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                STEP_CERTIFICATE_TYPEHASH,
                c.stepDigest,
                c.evidenceHash,
                c.policyDefinitionHash,
                c.effectivePolicyHash,
                c.issuedAt,
                c.validUntil,
                c.signerEpoch
            )
        );
    }

    function mandateDigest(TradeMandate calldata m) public view returns (bytes32) {
        return _hashTypedDataV4(hashMandate(m));
    }

    function stepDigest(Step calldata s) public view returns (bytes32) {
        return _hashTypedDataV4(hashStep(s));
    }

    function certificateDigest(StepCertificate calldata c) public view returns (bytes32) {
        return _hashTypedDataV4(hashCertificate(c));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Commitment for a sorted, unique output-token list (same rule as `outputSetHash` in core/eip712.ts):
    ///         keccak256 of the TIGHT 20-byte concatenation of the addresses (what viem's `encodePacked` of address
    ///         elements produces). NOTE: this is deliberately NOT `abi.encodePacked(address[])`, which pads every
    ///         element to 32 bytes.
    function computeOutputSetHash(address[] calldata outputSet) public pure returns (bytes32) {
        _requireSorted(outputSet);
        return _packedSetHash(outputSet);
    }

    /* ---------------------------------------------------------------------- */
    /*                                  Views                                 */
    /* ---------------------------------------------------------------------- */

    function mandateState(bytes32 digest) external view returns (uint256 spent, uint32 steps, bool revoked) {
        MandateState storage st = _mandates[digest];
        return (st.spent, st.steps, st.revoked);
    }

    /* ---------------------------------------------------------------------- */
    /*                                  User                                  */
    /* ---------------------------------------------------------------------- */

    /// @notice Stop a mandate for good (owner only). Steps already executed are unaffected.
    function revokeMandate(TradeMandate calldata m) external {
        if (msg.sender != m.owner) revert NotMandateOwner();
        bytes32 digest = mandateDigest(m);
        _mandates[digest].revoked = true;
        emit MandateRevoked(m.owner, digest);
    }

    /// @notice Burn a mandate nonce so any mandate signed with it can never start.
    function cancelMandateNonce(uint256 nonce) external {
        if (mandateNonceUsed[msg.sender][nonce]) revert MandateNonceAlreadyUsed();
        mandateNonceUsed[msg.sender][nonce] = true;
        emit MandateNonceCancelled(msg.sender, nonce);
    }

    /* ---------------------------------------------------------------------- */
    /*                                Execute                                 */
    /* ---------------------------------------------------------------------- */

    /// @notice Execute the next step of a mandate. Callable by anyone; reverts entirely on any violated bound.
    /// @param m              the user-signed mandate
    /// @param mandateSig     owner's EIP-712 signature over `mandateDigest(m)`
    /// @param outputSet      the mandate's output tokens, strictly ascending, matching `m.outputSetHash`
    /// @param s              the step (must be `stepIndex == steps executed so far`)
    /// @param c              service-signed certificate over `stepDigest(s)`
    /// @param certSig        attestation signer's signature over `certificateDigest(c)`
    /// @param routerCalldata exact router calldata (`keccak256 == s.calldataHash`)
    function executeStep(
        TradeMandate calldata m,
        bytes calldata mandateSig,
        address[] calldata outputSet,
        Step calldata s,
        StepCertificate calldata c,
        bytes calldata certSig,
        bytes calldata routerCalldata
    ) external payable nonReentrant whenNotPaused returns (uint256 spent, uint256 received, uint256 refunded) {
        if (msg.value != 0) revert NonZeroValue();
        bytes32 mDigest = _checkMandate(m, mandateSig, outputSet);
        MandateState storage st = _mandates[mDigest];
        _checkStep(m, st, mDigest, outputSet, s, routerCalldata);
        _checkCertificate(m, s, c, certSig);

        // ---- bind nonce at first step, before any external call ----
        if (s.stepIndex == 0) {
            if (mandateNonceUsed[m.owner][m.nonce]) revert MandateNonceAlreadyUsed();
            mandateNonceUsed[m.owner][m.nonce] = true;
            mandateOfNonce[m.owner][m.nonce] = mDigest;
        }
        st.steps += 1;

        uint256 pulled;
        (pulled, spent, received, refunded) = _pullSwapSettle(
            SwapParams({
                owner: m.owner,
                recipient: m.recipient,
                inputToken: m.inputToken,
                outputToken: s.outputToken,
                amountIn: s.amountIn,
                minAmountOut: s.minAmountOut,
                router: s.router,
                spender: s.spender
            }),
            routerCalldata
        );
        st.spent += spent;

        emit MandateStep(
            m.owner,
            mDigest,
            s.stepIndex,
            s.outputToken,
            s.amountIn,
            spent,
            received,
            refunded,
            s.evidenceHash,
            msg.sender
        );
    }

    /* ---------------------------------------------------------------------- */
    /*                               Internals                                */
    /* ---------------------------------------------------------------------- */

    function _checkMandate(TradeMandate calldata m, bytes calldata mandateSig, address[] calldata outputSet)
        internal
        view
        returns (bytes32 mDigest)
    {
        if (m.owner == address(0) || m.recipient == address(0)) revert ZeroAddress();
        if (m.budgetCap == 0 || m.perStepCap == 0 || m.maxSteps == 0) revert ZeroAmount();
        if (block.timestamp < m.validFrom) revert MandateNotYetValid();
        if (block.timestamp > m.deadline) revert MandateExpired();
        _requireSorted(outputSet);
        if (_packedSetHash(outputSet) != m.outputSetHash) revert OutputSetMismatch();

        mDigest = _hashTypedDataV4(hashMandate(m));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(mDigest, mandateSig);
        if (err != ECDSA.RecoverError.NoError || signer != m.owner) revert InvalidMandateSignature();
        if (_mandates[mDigest].revoked) revert MandateRevokedError();
        // a nonce cancelled (or bound to another mandate) before this mandate started blocks it
        if (_mandates[mDigest].steps == 0 && mandateNonceUsed[m.owner][m.nonce]) revert MandateNonceAlreadyUsed();
    }

    function _checkStep(
        TradeMandate calldata m,
        MandateState storage st,
        bytes32 mDigest,
        address[] calldata outputSet,
        Step calldata s,
        bytes calldata routerCalldata
    ) internal view {
        if (s.mandateDigest != mDigest) revert StepMandateMismatch();
        if (s.stepIndex != st.steps) revert StepOutOfOrder(st.steps, s.stepIndex);
        if (st.steps >= m.maxSteps) revert StepsExhausted();
        if (s.amountIn == 0 || s.minAmountOut == 0) revert ZeroAmount();
        if (s.amountIn > m.perStepCap) revert PerStepCapExceeded();
        if (st.spent + s.amountIn > m.budgetCap) revert BudgetExceeded();
        if (block.timestamp > s.deadline) revert StepExpired();
        if (!_contains(outputSet, s.outputToken)) revert OutputNotInSet();
        _checkRouteAndTokens(
            m.inputToken,
            s.outputToken,
            s.router,
            s.spender,
            s.calldataHash,
            m.policyDefinitionHash,
            m.registryHash,
            routerCalldata
        );
    }

    function _checkCertificate(
        TradeMandate calldata m,
        Step calldata s,
        StepCertificate calldata c,
        bytes calldata certSig
    ) internal view {
        if (c.stepDigest != _hashTypedDataV4(hashStep(s))) revert CertificateStepMismatch();
        if (
            c.evidenceHash != s.evidenceHash || c.policyDefinitionHash != m.policyDefinitionHash
                || c.effectivePolicyHash != m.effectivePolicyHash
        ) revert CertificateBindingMismatch();
        if (c.validUntil > s.deadline || c.validUntil > m.deadline) revert CertificateOutlivesStep();
        _checkCertificateWindowAndSigner(
            c.issuedAt, c.validUntil, c.signerEpoch, _hashTypedDataV4(hashCertificate(c)), certSig
        );
    }

    /// @dev strictly ascending ⇒ unique; empty set rejected
    function _requireSorted(address[] calldata set) internal pure {
        uint256 n = set.length;
        if (n == 0) revert OutputSetNotSorted();
        for (uint256 i = 1; i < n; i++) {
            if (uint160(set[i]) <= uint160(set[i - 1])) revert OutputSetNotSorted();
        }
    }

    /// @dev tight 20-byte concatenation, then keccak256 (sets are tiny; a memory loop is fine)
    function _packedSetHash(address[] calldata set) internal pure returns (bytes32) {
        bytes memory buf;
        for (uint256 i = 0; i < set.length; i++) {
            buf = abi.encodePacked(buf, set[i]);
        }
        return keccak256(buf);
    }

    function _contains(address[] calldata set, address token) internal pure returns (bool) {
        for (uint256 i = 0; i < set.length; i++) {
            if (set[i] == token) return true;
        }
        return false;
    }
}
