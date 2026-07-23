// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal ERC-721-style NFT for the demo. Its `setApprovalForAll` grants an
/// operator control over EVERY token the owner holds — the NFT-world
/// equivalent of an unlimited approval, and a very common real drain vector.
contract DemoNFT {
    string public constant name = "Demo Punks";
    string public constant symbol = "DPUNK";

    address public immutable minter;
    mapping(uint256 => address) public ownerOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor() {
        minter = msg.sender;
    }

    function mint(address to, uint256 tokenId) external {
        require(msg.sender == minter, "not minter");
        ownerOf[tokenId] = to;
        emit Transfer(address(0), to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }
}
