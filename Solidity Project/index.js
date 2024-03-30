import { formatUnits } from "@ethersproject/units";
import { ethers } from "ethers";
import { CONTRACTS, wssProvider, searcherWallet } from "./src/constants.js";
import {
  logDebug,
  logError,
  logFatal,
  logInfo,
  logSuccess,
  logTrace,
} from "./src/logging.js";
import { calcSandwichOptimalIn, calcSandwichState , calcSandwichOptimalInWithNoSearch} from "./src/numeric.js";
import { parseUniv2RouterTx } from "./src/parse.js";
import {
  callBundleFlashbots,
  getRawTransaction,
  sanityCheckSimulationResponse,
  sendBundleFlashbots,
} from "./src/relayer.js";
import {
  getUniv2ExactWethTokenMinRecv,
  getUniv2PairAddress,
  getUniv2Reserve,
} from "./src/univ2.js";
import { calcNextBlockBaseFee, match, stringifyBN } from "./src/utils.js";

let currentBlockNumber, nextBaseFee;

// Note: You'll probably want to break this function up
//       handling everything in here so you can follow along easily
const sandwichUniswapV2RouterTx = async (txHash) => {
  const strLogPrefix = `txhash=${txHash}`;

  // Bot not broken right
  // logTrace(strLogPrefix, "received");

  // Get tx data
  let tx = await wssProvider.getTransaction(txHash);

  // Sometimes tx is null for some reason
  if (tx === null) {
    // console.log(tx, "tx is null");
    return;
  }

  // We're not a generalized version
  // So we're just gonna listen to specific addresses
  // and decode the data from there
  if (!match(tx.to, CONTRACTS.UNIV2_ROUTER)) {
    // console.log("The tx does not match with uniswap v2 router");
    return;
  }

  // Decode transaction data
  // i.e. is this swapExactETHForToken?
  // You'll have to decode all the other possibilities :P
  const routerDataDecoded = parseUniv2RouterTx(tx.data);
  // console.log("router decoded result", routerDataDecoded);

  // Basically means its not swapExactETHForToken and you need to add
  // other possibilities
  if (routerDataDecoded === null) {
    // console.log("This is not swapExactETHForToken");
    return;
  }

  const { path, amountOutMin, deadline } = routerDataDecoded;

  // If tx deadline has passed, just ignore it
  // As we cannot sandwich it

  // if (new Date().getTime() / 1000 > deadline) {
  //   console.log("Deadline has passed!");
  //   return;
  // }

  // Get the min recv for token directly after WETH
  const userMinRecv = await getUniv2ExactWethTokenMinRecv(amountOutMin, path);

  const userAmountIn = tx.value; // User is sending exact ETH (not WETH)

  logTrace(
    strLogPrefix,
    "potentially sandwichable swapExactETHForTokens tx found",
    JSON.stringify(
      stringifyBN({
        userAmountIn,
        userMinRecv,
        path,
      })
    )
  );

  // Note: Since this is swapExactETHForTokens, the path will always be like so
  // Get the optimal in amount
  const [weth, token] = path;
  const pairToSandwich = getUniv2PairAddress(weth, token);
  const [reserveWeth, reserveToken] = await getUniv2Reserve(
    pairToSandwich,
    weth,
    token
  );

  // const optimalWethIn = calcSandwichOptimalInWithNoSearch(
  //   userAmountIn,
  //   userMinRecv,
  //   reserveWeth,
  //   reserveToken
  // );

  // console.log(optimalWethIn.toString());

  // const optimalWethIn = ethers.utils.parseEther("0.01");

  // console.log(optimalWethIn);

  // Lmeow, nothing to sandwich!

  // if (optimalWethIn.lte(ethers.constants.Zero)) {
  //   console.log("Nothing to Sandwich")
  //   return;
  // }

  const optimalWethIn = ethers.utils.parseEther("0.001");

  // Contains 3 states:
  // 1: Frontrun state
  // 2: Victim state
  // 3: Backrun state
  const sandwichStates = calcSandwichState(
    optimalWethIn,
    userAmountIn,
    userMinRecv,
    reserveWeth,
    reserveToken
  );

  // Sanity check failed
  if (sandwichStates === null) {
    logDebug(
      strLogPrefix,
      "sandwich sanity check failed",
      JSON.stringify(
        stringifyBN({
          optimalWethIn,
          reserveToken,
          reserveWeth,
          userAmountIn,
          userMinRecv,
        })
      )
    );
    return;
  }

  // if (sandwichStates.revenue.lte(ethers.constants.Zero)) {
  //   console.log("Profit is lower than zero");
  //   return;
  // }

  // Cool profitable sandwich :)
  // But will it be post gas?
  logInfo(
    strLogPrefix,
    "sandwichable target found",
    JSON.stringify(stringifyBN(sandwichStates))
  );

  // Get block data to compute bribes etc
  // as bribes calculation has correlation with gasUsed
  const block = await wssProvider.getBlock();
  const targetBlockNumber = block.number + 1;
  const nextBaseFee = calcNextBlockBaseFee(block);
  const nonce = await wssProvider.getTransactionCount(searcherWallet.address);

  // Craft our payload
  const frontslicePayload = ethers.utils.solidityPack(
    ["address", "address", "uint128", "uint128", "uint8"],
    [
      weth,
      pairToSandwich,
      optimalWethIn,
      sandwichStates.frontrun.amountOut,
      ethers.BigNumber.from(token).lt(ethers.BigNumber.from(weth)) ? 0 : 1,
    ]
  );
  const frontsliceTx = {
    to: CONTRACTS.SANDWICH,
    from: searcherWallet.address,
    data: frontslicePayload,
    chainId: 1,
    maxPriorityFeePerGas: ethers.utils.parseUnits('20', 'gwei'),
    maxFeePerGas: ethers.utils.parseUnits('100', 'gwei'),
    gasLimit: 250000,
    nonce,
    type: 2,
  };
  const frontsliceTxSigned = await searcherWallet.signTransaction(frontsliceTx);

  const middleTx = getRawTransaction(tx);

  const backslicePayload = ethers.utils.solidityPack(
    ["address", "address", "uint128", "uint128", "uint8"],
    [
      token,
      pairToSandwich,
      sandwichStates.frontrun.amountOut,
      sandwichStates.backrun.amountOut,
      ethers.BigNumber.from(weth).lt(ethers.BigNumber.from(token)) ? 0 : 1,
    ]
  );
  const backsliceTx = {
    to: CONTRACTS.SANDWICH,
    from: searcherWallet.address,
    data: backslicePayload,
    chainId: 1,
    maxPriorityFeePerGas: ethers.utils.parseUnits('20', 'gwei'),
    maxFeePerGas: ethers.utils.parseUnits('100', 'gwei'),
    gasLimit: 250000,
    nonce: nonce + 1,
    type: 2,
  };
  const backsliceTxSigned = await searcherWallet.signTransaction(backsliceTx);

  // Simulate tx to get the gas used
  const signedTxs = [frontsliceTxSigned, middleTx, backsliceTxSigned];
  let simulatedResp = await callBundleFlashbots(signedTxs, targetBlockNumber);

  // Try and check all the errors
  try {
    sanityCheckSimulationResponse(simulatedResp);
  } catch (e) {
    logError(
      strLogPrefix,
      "error while simulating",
      JSON.stringify(
        stringifyBN({
          error: e,
          // block,
          targetBlockNumber,
          nextBaseFee,
          nonce,
          sandwichStates,
          frontsliceTx,
          backsliceTx,
        })
      )
    );
    return;
  }

  // Extract gas
  // const frontsliceGas = ethers.BigNumber.from(simulatedResp.results[0].gasUsed);
  // const backsliceGas = ethers.BigNumber.from(simulatedResp.results[2].gasUsed);

  // // Bribe 99.99% :P
  // const bribeAmount = sandwichStates.revenue.sub(
  //   frontsliceGas.mul(nextBaseFee)
  // );
  // const maxPriorityFeePerGas = bribeAmount
  //   .mul(9999)
  //   .div(10000)
  //   .div(backsliceGas);

  // // Note: you probably want some circuit breakers here so you don't lose money
  // // if you fudged shit up

  // // If 99.99% bribe isn't enough to cover base fee, its not worth it
  // if (maxPriorityFeePerGas.lt(nextBaseFee)) {
  //   logTrace(
  //     strLogPrefix,
  //     `maxPriorityFee (${formatUnits(
  //       maxPriorityFeePerGas,
  //       9
  //     )}) gwei < nextBaseFee (${formatUnits(nextBaseFee, 9)}) gwei`
  //   );
  //   return;
  // }

  // // Okay, update backslice tx
  // const backsliceTxSignedWithBribe = await searcherWallet.signTransaction({
  //   ...backsliceTx,
  //   maxPriorityFeePerGas,
  // });

  // Fire the bundles
  const bundleResp = await sendBundleFlashbots(
    [frontsliceTxSigned, middleTx, backsliceTxSigned],
    simulatedResp.result.stateBlockNumber + 1
  );
  logSuccess(
    strLogPrefix,
    "Bundle submitted!",
    JSON.stringify(
      bundleResp
    )
  );
};

const main = async () => {
  // Add timestamp to all subsequent console.logs
  // One little two little three little dependency injections....
  const origLog = console.log;
  console.log = function (obj, ...placeholders) {
    if (typeof obj === "string")
      placeholders.unshift("[" + new Date().toISOString() + "] " + obj);
    else {
      // This handles console.log( object )
      placeholders.unshift(obj);
      placeholders.unshift("[" + new Date().toISOString() + "] %j");
    }

    origLog.apply(this, placeholders);
  };

  logInfo("Listening to mempool...\n");

  // sandwichUniswapV2RouterTx("0xd67b778f84312853da215013be838c1cb705b28776a48285430450662a7ad997");
  // Listen to the mempool on local node

  wssProvider.on("pending", (txHash) => {
    sandwichUniswapV2RouterTx(txHash).catch((e) => {
      logFatal(`txhash=${txHash} error ${JSON.stringify(e)}`);
    })
  });
};

main();
