import { ethers } from "ethers";
import { parseUnits } from "@ethersproject/units";
import { getUniv2DataGivenIn } from "./univ2.js";

const BN_18 = parseUnits("1");

/*
  Binary search to find optimal sandwichable amount

  Using binary search here as the profit function isn't normally distributed
*/
export const binarySearch = (
  left, // Lower bound
  right, // Upper bound
  calculateF, // Generic calculate function
  passConditionF, // Condition checker
  tolerance = parseUnits("0.01") // Tolerable delta (in %, in 18 dec, i.e. parseUnits('0.01') means left and right delta can be 1%)
) => {
  if (right.sub(left).gt(tolerance.mul(right.add(left).div(2)).div(BN_18))) {
    const mid = right.add(left).div(2);
    const out = calculateF(mid);

    // If we pass the condition
    // Number go up
    if (passConditionF(out)) {
      return binarySearch(mid, right, calculateF, passConditionF, tolerance);
    }

    // Number go down
    return binarySearch(left, mid, calculateF, passConditionF, tolerance);
  }

  // No negatives
  const ret = right.add(left).div(2);
  if (ret.lt(0)) {
    return ethers.constants.Zero;
  }

  return ret;
};

/*
  Calculate the max sandwich amount
*/

export const calcSandwichOptimalIn = (
  userAmountIn,
  userMinRecvToken,
  reserveWeth,
  reserveToken
) => {
  // Note that user is going from WETH -> TOKEN
  // So, we'll be pushing the price of TOKEn
  // by swapping WETH -> TOKEN before the user
  // i.e. Ideal tx placement:
  // 1. (Ours) WETH -> TOKEN (pushes up price)
  // 2. (Victim) WETH -> TOKEN (pushes up price more)
  // 3. (Ours) TOKEN -> WETH (sells TOKEN for slight WETH profit)
  const calcF = (amountIn) => {
    const frontrunState = getUniv2DataGivenIn(
      amountIn,
      reserveWeth,
      reserveToken
    );
    const victimState = getUniv2DataGivenIn(
      userAmountIn,
      frontrunState.newReserveA,
      frontrunState.newReserveB
    );
    return victimState.amountOut;
  };

  // Our binary search must pass this function
  // i.e. User must receive at least min this
  const passF = (amountOut) => amountOut.gte(userMinRecvToken);

  // Lower bound will be 0
  // Upper bound will be 100 ETH (hardcoded, or however much ETH you have on hand)
  // Feel free to optimize and change it
  // It shouldn't be hardcoded hehe....
  const lowerBound = parseUnits("0");
  const upperBound = parseUnits("2");

  // Optimal WETH in to push reserve to the point where the user
  // _JUST_ receives their min recv
  const optimalWethIn = binarySearch(lowerBound, upperBound, calcF, passF);

  return optimalWethIn;
};


function sqrt(value) {
  const ONE = ethers.BigNumber.from(1);
  const TWO = ethers.BigNumber.from(2);
  let x = value;
  let z = x.add(ONE).div(TWO);
  let y = x;
  while (z.sub(y).isNegative()) {
      y = z;
      z = x.div(z).add(z).div(TWO);
  }
  return y;
}

export const calcSandwichOptimalInWithNoSearch = (
  userAmountIn,
  userMinRecvToken,
  reserveWeth,
  reserveToken
) => {
  let UMR = ethers.utils.parseUnits(userMinRecvToken, 'wei');
  if(UMR.toString() == "0")
    UMR = UMR.add(1);

  // console.log("Actually user can get :", getUniv2DataGivenIn(userAmountIn, reserveWeth, reserveToken).amountOut.toString());

  let A = reserveToken.mul(reserveWeth).mul(userAmountIn).mul(997).mul(1000);
  let B = userAmountIn.mul(997).add(reserveWeth.mul(1000));
  let C = reserveWeth.mul(UMR).mul(1000);

  let AA = UMR.mul(ethers.utils.parseUnits('997000', 'wei'));
  let BB = B.mul(997).mul(UMR).add(C.mul(1000));
  let CC = B.mul(C).sub(A);
  

  let D = BB.mul(BB).sub(CC.mul(AA).mul(4));
  let x = sqrt(D).sub(BB).div(AA.mul(2));
  
  // console.log(x.toString(), userAmountIn.toString());
  
  // const amountIn = getUniv2DataGivenIn(x, reserveWeth, reserveToken);
  // console.log(amountIn);
  // const amountInR = getUniv2DataGivenIn(userAmountIn, amountIn.newReserveA, amountIn.newReserveB);
  // console.log("amountInR.amountOut.toString()", amountInR.amountOut.toString());

  return x;
}

export const calcSandwichState = (
  optimalSandwichWethIn,
  userWethIn,
  userMinRecv,
  reserveWeth,
  reserveToken
) => {
  const frontrunState = getUniv2DataGivenIn(
    optimalSandwichWethIn,
    reserveWeth,
    reserveToken
  );
  const victimState = getUniv2DataGivenIn(
    userWethIn,
    frontrunState.newReserveA,
    frontrunState.newReserveB
  );
  const backrunState = getUniv2DataGivenIn(
    frontrunState.amountOut,
    victimState.newReserveB,
    victimState.newReserveA
  );

  // Sanity check
  if (victimState.amountOut.lt(userMinRecv)) {
    return null;
  }

  // Return
  return {
    // NOT PROFIT
    // Profit = post gas
    revenue: backrunState.amountOut.sub(optimalSandwichWethIn),
    optimalSandwichWethIn,
    userAmountIn: userWethIn,
    userMinRecv,
    reserveState: {
      reserveWeth,
      reserveToken,
    },
    frontrun: frontrunState,
    victim: victimState,
    backrun: backrunState,
  };
};
