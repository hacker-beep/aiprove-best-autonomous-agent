import test from "node:test";
import assert from "node:assert/strict";
import { analyzeContract, extractGithubRepo, parseFunctions } from "../lib/audit.mjs";

// A small vault exhibiting the same six classic bug patterns as the real
// StakePool challenge, under different names — so the tests prove the
// detectors are generic, not tuned to one contract.
const BUGGY_VAULT = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IOracle {
    function price() external view returns (uint256);
}

contract MiniVault {
    IERC20 public token;
    IOracle public oracle;
    address public owner;
    bool private setup;
    uint256 public feeRate;
    uint256 public total;
    mapping(address => uint256) public bal;

    modifier nonReentrant() {
        _;
    }

    function init(address _token, address _oracle) external {
        require(!setup, "init");
        token = IERC20(_token);
        oracle = IOracle(_oracle);
        owner = msg.sender;
    }

    function takeover() external {
        owner = msg.sender;
    }

    function getValue(uint256 amount) public view returns (uint256) {
        return (amount * oracle.price()) / 1e18;
    }

    function deposit(uint256 amount) external nonReentrant {
        token.transferFrom(msg.sender, address(this), amount);
        bal[msg.sender] += amount;
        total += amount;
    }

    function cashout(uint256 amount) external {
        require(bal[msg.sender] >= amount, "insufficient");
        token.transfer(msg.sender, amount);
        bal[msg.sender] -= amount;
        total -= amount;
    }

    function setRate(uint256 rate) external {
        feeRate = rate;
    }
}
`;

// The same vault written correctly: every detector must stay silent.
const CLEAN_VAULT = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IOracle {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

contract CleanVault {
    IERC20 public token;
    IOracle public oracle;
    address public owner;
    bool private setup;
    uint256 public feeRate;
    uint256 public total;
    uint256 public acc;
    mapping(address => uint256) public bal;
    bool private entered;

    modifier nonReentrant() {
        require(!entered, "reentrant");
        entered = true;
        _;
        entered = false;
    }
    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function init(address _token) external {
        require(!setup, "init");
        setup = true;
        token = IERC20(_token);
        owner = msg.sender;
    }

    function transferOwnership(address next) external onlyOwner {
        owner = next;
    }

    function getValue(uint256 amount) public view returns (uint256) {
        (, int256 p, , uint256 updatedAt, ) = oracle.latestRoundData();
        require(block.timestamp - updatedAt < 3600, "stale");
        return (amount * uint256(p)) / 1e18;
    }

    function deposit(uint256 amount) external nonReentrant {
        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
        bal[msg.sender] += amount;
        total += amount;
    }

    function cashout(uint256 amount) external nonReentrant {
        require(bal[msg.sender] >= amount, "insufficient");
        bal[msg.sender] -= amount;
        total -= amount;
        require(token.transfer(msg.sender, amount), "transfer failed");
    }

    function setRate(uint256 rate) external onlyOwner {
        _accrue();
        feeRate = rate;
    }

    function _accrue() internal {
        acc = block.timestamp;
    }
}
`;

test("analyzeContract: buggy vault yields all six finding classes", () => {
  const tokens = analyzeContract(BUGGY_VAULT).map((f) => f.token);
  assert.deepEqual(tokens, [
    "init:reinitialization",
    "takeover:access-control",
    "getValue:price-manipulation",
    "deposit:unchecked-return",
    "cashout:reentrancy",
    "setRate:logic",
  ]);
});

test("analyzeContract: every finding carries a reason", () => {
  for (const f of analyzeContract(BUGGY_VAULT)) {
    assert.ok(f.reason && f.reason.length > 10, f.token);
  }
});

test("analyzeContract: clean vault yields zero findings", () => {
  assert.deepEqual(analyzeContract(CLEAN_VAULT), []);
});

test("analyzeContract: unchecked-return reported once, at the earliest function", () => {
  const tokens = analyzeContract(BUGGY_VAULT).map((f) => f.token);
  const unchecked = tokens.filter((t) => t.endsWith(":unchecked-return"));
  assert.deepEqual(unchecked, ["deposit:unchecked-return"]);
});

test("analyzeContract: guarded external call + state write is not reentrancy", () => {
  const tokens = analyzeContract(BUGGY_VAULT).map((f) => f.token);
  assert.ok(!tokens.includes("deposit:reentrancy"), "deposit has nonReentrant");
  assert.ok(tokens.includes("cashout:reentrancy"));
});

test("parseFunctions: finds all functions, skips interface stubs", () => {
  const names = parseFunctions(BUGGY_VAULT).map((f) => f.name);
  assert.deepEqual(names, ["init", "takeover", "getValue", "deposit", "cashout", "setRate"]);
});

test("extractGithubRepo: pulls owner/repo from brief text", () => {
  assert.deepEqual(
    extractGithubRepo("published at https://github.com/AIProveRH/stakepool-challenge. Read the contract."),
    { owner: "AIProveRH", repo: "stakepool-challenge", url: "https://github.com/AIProveRH/stakepool-challenge" },
  );
  assert.equal(extractGithubRepo("no repo here"), null);
});
