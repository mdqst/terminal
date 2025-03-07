import { TokenInfo } from '@solana/spl-token-registry';
import Decimal from 'decimal.js';
import React, { useMemo } from 'react';
import { formatNumber } from 'src/misc/utils';

export type PlatformFeesInfo =
  | {
      platformFee: {
        amount: string;
        feeBps: number;
      };
    }
  | undefined;

const PlatformFees = ({ platformFee, tokenInfo }: PlatformFeesInfo & { tokenInfo: TokenInfo }) => {
  const amountText = useMemo(() => {
    if (platformFee && Number(platformFee?.amount) > 0) {
      return formatNumber.format(new Decimal(platformFee?.amount).div(10 ** tokenInfo.decimals), tokenInfo.decimals);
    }
    return null;
  }, [platformFee, tokenInfo.decimals]);

  const feeBps = useMemo(() => {
    if (platformFee) {
      return platformFee?.feeBps / 100 + '%';
    }
    return null;
  }, [platformFee]);

  return (
    <div className="flex items-center justify-between text-xs">
      <div className="flex w-[50%] text-white/30">
        <span>Platform Fee</span>
      </div>
      <div className="text-white/30">
        {amountText} {tokenInfo.symbol} ({feeBps})
      </div>
    </div>
  );
};

export default PlatformFees;
