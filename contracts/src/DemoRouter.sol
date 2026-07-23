// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal swap-router stand-in for the demo chain. Emits a Swap event so
/// fork simulation shows real activity; deliberately moves no funds.
contract DemoRouter {
    event Swap(address indexed sender, uint256 amountIn, uint256 amountOutMin, address to);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata, /* path */
        address to,
        uint256 /* deadline */
    ) external returns (uint256[] memory amounts) {
        emit Swap(msg.sender, amountIn, amountOutMin, to);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOutMin;
    }
}
