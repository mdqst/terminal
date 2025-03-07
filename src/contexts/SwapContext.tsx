import { fetchSourceAddressAndDestinationAddress, getTokenBalanceChangesFromTransactionResponse } from '@jup-ag/common';
import { Owner, QuoteResponseMeta, SwapMode, SwapResult, UseJupiterProps, useJupiter } from '@jup-ag/react-hook';
import { SignerWalletAdapter, useConnection, useLocalStorage } from '@jup-ag/wallet-adapter';
import { TokenInfo } from '@solana/spl-token-registry';
import { PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import JSBI from 'jsbi';
import {
  Dispatch,
  FC,
  MutableRefObject,
  ReactNode,
  SetStateAction,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { DEFAULT_MAX_DYNAMIC_SLIPPAGE_PCT, DEFAULT_SLIPPAGE_PCT, WRAPPED_SOL_MINT } from 'src/constants';
import { fromLamports, getAssociatedTokenAddressSync, hasNumericValue } from 'src/misc/utils';
import { useReferenceFeesQuery } from 'src/queries/useReferenceFeesQuery';
import { FormProps, IInit, IOnRequestIxCallback } from 'src/types';
import { usePrioritizationFee } from './PrioritizationFeeContextProvider';
import { useScreenState } from './ScreenProvider';
import { useTokenContext } from './TokenContextProvider';
import { useWalletPassThrough } from './WalletPassthroughProvider';
import { useAccounts } from './accounts';
import { useExecuteTransaction } from 'src/hooks/useExecuteTransaction';

export type SlippageMode = 'DYNAMIC' | 'FIXED';
const SLIPPAGE_MODE_DEFAULT: SlippageMode = 'DYNAMIC';

export interface IForm {
  fromMint: string;
  toMint: string;
  fromValue: string;
  toValue: string;
  slippageBps: number;
  userSlippageMode: SlippageMode;
  dynamicSlippageBps: number;
}

export type SwappingStatus = 'loading' | 'pending-approval' | 'sending' | 'fail' | 'success' | 'timeout';
export interface ISwapContext {
  form: IForm;
  setForm: Dispatch<SetStateAction<IForm>>;
  isToPairFocused: MutableRefObject<boolean>;

  errors: Record<string, { title: string; message: string }>;
  setErrors: Dispatch<
    SetStateAction<
      Record<
        string,
        {
          title: string;
          message: string;
        }
      >
    >
  >;
  fromTokenInfo?: TokenInfo | null;
  toTokenInfo?: TokenInfo | null;
  quoteResponseMeta: QuoteResponseMeta | null;
  setQuoteResponseMeta: Dispatch<SetStateAction<QuoteResponseMeta | null>>;
  onSubmit: () => Promise<SwapResult | null>;
  onRequestIx: () => Promise<IOnRequestIxCallback>;
  lastSwapResult: { swapResult: SwapResult; quoteResponseMeta: QuoteResponseMeta | null } | null;
  formProps: FormProps;
  displayMode: IInit['displayMode'];
  scriptDomain: IInit['scriptDomain'];
  swapping: {
    txStatus:
      | {
          txid: string;
          status: SwappingStatus;
          quotedDynamicSlippageBps: string | undefined;
        }
      | undefined;
  };
  reset: (props?: { resetValues: boolean }) => void;
  jupiter: {
    asLegacyTransaction: boolean;
    setAsLegacyTransaction: Dispatch<SetStateAction<boolean>>;
    quoteResponseMeta: QuoteResponseMeta | undefined | null;
    loading: ReturnType<typeof useJupiter>['loading'];
    refresh: ReturnType<typeof useJupiter>['refresh'];
    error: ReturnType<typeof useJupiter>['error'];
    lastRefreshTimestamp: ReturnType<typeof useJupiter>['lastRefreshTimestamp'];
  };
  setUserSlippage: Dispatch<SetStateAction<number>>;
  setUserSlippageDynamic: Dispatch<SetStateAction<number>>;
  setUserSlippageMode: Dispatch<SetStateAction<SlippageMode>>;
}

export const SwapContext = createContext<ISwapContext | null>(null);

export class SwapTransactionTimeoutError extends Error {
  constructor() {
    super('Transaction timed-out');
  }
}

export function useSwapContext() {
  const context = useContext(SwapContext);
  if (!context) throw new Error('Missing SwapContextProvider');
  return context;
}

export const PRIORITY_NONE = 0; // No additional fee
export const PRIORITY_HIGH = 0.000_005; // Additional fee of 1x base fee
export const PRIORITY_TURBO = 0.000_5; // Additional fee of 100x base fee
export const PRIORITY_MAXIMUM_SUGGESTED = 0.01;

const INITIAL_FORM = {
  fromMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  toMint: WRAPPED_SOL_MINT.toString(),
  fromValue: '',
  toValue: '',
  slippageBps: Math.ceil(DEFAULT_SLIPPAGE_PCT * 100),
  userSlippageMode: SLIPPAGE_MODE_DEFAULT,
  dynamicSlippageBps: Math.ceil(DEFAULT_MAX_DYNAMIC_SLIPPAGE_PCT * 100),
};

export const SwapContextProvider: FC<{
  displayMode: IInit['displayMode'];
  scriptDomain?: string;
  asLegacyTransaction: boolean;
  setAsLegacyTransaction: React.Dispatch<React.SetStateAction<boolean>>;
  formProps?: FormProps;
  maxAccounts?: number;
  useUserSlippage?: boolean;
  slippagePresets?: number[];
  children: ReactNode;
}> = (props) => {
  const {
    displayMode,
    scriptDomain,
    asLegacyTransaction,
    setAsLegacyTransaction,
    formProps: originalFormProps,
    maxAccounts,
    children,
  } = props;
  const { screen } = useScreenState();
  const { isLoaded, getTokenInfo } = useTokenContext();
  const { wallet } = useWalletPassThrough();
  const { refresh: refreshAccount } = useAccounts();

  const walletPublicKey = useMemo(() => wallet?.adapter.publicKey?.toString(), [wallet?.adapter.publicKey]);
  const formProps: FormProps = useMemo(() => ({ ...INITIAL_FORM, ...originalFormProps }), [originalFormProps]);
  const [userSlippage, setUserSlippage] = useLocalStorage<number>('jupiter-terminal-slippage', DEFAULT_SLIPPAGE_PCT);
  const [userSlippageDynamic, setUserSlippageDynamic] = useLocalStorage<number>(
    'jupiter-terminal-slippage-dynamic',
    DEFAULT_MAX_DYNAMIC_SLIPPAGE_PCT,
  );
  const [userSlippageMode, setUserSlippageMode] = useLocalStorage<SlippageMode>(
    'jupiter-terminal-slippage-mode',
    SLIPPAGE_MODE_DEFAULT,
  );
  const [form, setForm] = useState<IForm>(
    (() => {
      const getSlippageBps = (slippage: number) => {
        if (typeof slippage !== 'undefined') {
          return Math.ceil(slippage * 100);
        }

        if (formProps?.initialSlippageBps) {
          return formProps?.initialSlippageBps;
        }
        return Math.ceil(DEFAULT_SLIPPAGE_PCT * 100);
      };

      return {
        fromMint: formProps?.initialInputMint ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        toMint: formProps?.initialOutputMint ?? WRAPPED_SOL_MINT.toString(),
        fromValue: '',
        toValue: '',
        slippageBps: getSlippageBps(userSlippage),
        dynamicSlippageBps: getSlippageBps(userSlippageDynamic),
        userSlippageMode,
      };
    })(),
  );

  const [errors, setErrors] = useState<Record<string, { title: string; message: string }>>({});

  const fromTokenInfo = useMemo(() => {
    if (!isLoaded) return null;
    const tokenInfo = form.fromMint ? getTokenInfo(form.fromMint) : null;
    return tokenInfo;
  }, [form.fromMint, isLoaded, getTokenInfo]);

  const toTokenInfo = useMemo(() => {
    if (!isLoaded) return null;
    const tokenInfo = form.toMint ? getTokenInfo(form.toMint) : null;
    return tokenInfo;
  }, [form.toMint, getTokenInfo, isLoaded]);

  const isToPairFocused = useRef<boolean>(false);

  const swapMode = isToPairFocused.current ? SwapMode.ExactOut : SwapMode.ExactIn;

  // Set value given initial amount
  const setupInitialAmount = useCallback(() => {
    if (!formProps?.initialAmount || !fromTokenInfo || !toTokenInfo) return;

    const toUiAmount = (mint: string) => {
      const tokenInfo = mint ? getTokenInfo(mint) : undefined;
      if (!tokenInfo) return;
      return String(fromLamports(JSBI.BigInt(formProps.initialAmount ?? 0), tokenInfo.decimals));
    };

    if (swapMode === SwapMode.ExactOut) {
      setTimeout(() => {
        setForm((prev) => {
          return { ...prev, toValue: toUiAmount(prev.toMint) ?? '' };
        });
      }, 0);
    } else {
      setTimeout(() => {
        setForm((prev) => ({ ...prev, fromValue: toUiAmount(prev.fromMint) ?? '' }));
      }, 0);
    }
  }, [formProps.initialAmount, fromTokenInfo, getTokenInfo, swapMode, toTokenInfo]);

  useEffect(() => {
    setupInitialAmount();
  }, [formProps.initialAmount, setupInitialAmount]);

  // We dont want to effect to keep trigger for fromValue and toValue
  const userInputChange = useMemo(() => {
    if (swapMode === SwapMode.ExactOut) {
      return form.toValue;
    } else {
      return form.fromValue;
    }
  }, [form.fromValue, form.toValue, swapMode]);
  const jupiterParams: UseJupiterProps = useMemo(() => {
    const amount = (() => {
      // ExactIn
      if (isToPairFocused.current === false) {
        if (!fromTokenInfo || !form.fromValue || !hasNumericValue(form.fromValue)) {
          return JSBI.BigInt(0);
        }
        return JSBI.BigInt(new Decimal(form.fromValue).mul(Math.pow(10, fromTokenInfo.decimals)).floor().toFixed());
      }

      // ExactOut
      if (!toTokenInfo || !form.toValue || !hasNumericValue(form.toValue)) {
        return JSBI.BigInt(0);
      }
      return JSBI.BigInt(new Decimal(form.toValue).mul(Math.pow(10, toTokenInfo.decimals)).floor().toFixed());
    })();

    return {
      amount,
      inputMint: form.fromMint ? new PublicKey(form.fromMint) : undefined,
      outputMint: form.toMint ? new PublicKey(form.toMint) : undefined,
      swapMode,
      slippageBps: form.slippageBps,
      maxAccounts,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    form.fromMint,
    form.slippageBps,
    form.toMint,
    userInputChange,
    fromTokenInfo?.address,
    swapMode,
    maxAccounts,
    toTokenInfo?.address,
  ]);

  // TODO: FIXME: useJupiter hooks currently calls Quote twice when switching SwapMode
  const {
    quoteResponseMeta: ogQuoteResponseMeta,
    refresh,
    loading,
    error,
    lastRefreshTimestamp,
    fetchSwapTransaction,
  } = useJupiter(jupiterParams);

  const { data: referenceFees } = useReferenceFeesQuery();
  const { priorityLevel, modifyComputeUnitPriceAndLimit } = usePrioritizationFee();
  const { connection } = useConnection();

  const [quoteResponseMeta, setQuoteResponseMeta] = useState<QuoteResponseMeta | null>(null);
  useEffect(() => {
    if (!ogQuoteResponseMeta) {
      setQuoteResponseMeta(null);
      return;
    }
    // the UI sorts the best route depending on ExactIn or ExactOut
    setQuoteResponseMeta(ogQuoteResponseMeta);
  }, [swapMode, ogQuoteResponseMeta]);

  useEffect(() => {
    if (!form.fromValue && !quoteResponseMeta) {
      setForm((prev) => ({ ...prev, fromValue: '', toValue: '' }));
      return;
    }

    setForm((prev) => {
      const newValue = { ...prev };

      if (!fromTokenInfo || !toTokenInfo) return prev;

      let { inAmount, outAmount } = quoteResponseMeta?.quoteResponse || {};
      if (swapMode === SwapMode.ExactIn) {
        newValue.toValue = outAmount ? new Decimal(outAmount.toString()).div(10 ** toTokenInfo.decimals).toFixed() : '';
      } else {
        newValue.fromValue = inAmount
          ? new Decimal(inAmount.toString()).div(10 ** fromTokenInfo.decimals).toFixed()
          : '';
      }
      return newValue;
    });
  }, [form.fromValue, fromTokenInfo, quoteResponseMeta, swapMode, toTokenInfo]);

  const [txStatus, setTxStatus] = useState<ISwapContext['swapping']['txStatus']>(undefined);
  const [lastSwapResult, setLastSwapResult] = useState<ISwapContext['lastSwapResult']>(null);

  const onSubmitWithIx = useCallback(
    (swapResult: SwapResult) => {
      try {
        if ('error' in swapResult) throw swapResult.error;

        if ('txid' in swapResult) {
          console.log({ swapResult });
          setTxStatus((prev) => ({
            txid: swapResult.txid,
            status: 'success',
            quotedDynamicSlippageBps: prev?.quotedDynamicSlippageBps,
          }));
          setLastSwapResult({ swapResult, quoteResponseMeta });
        }
      } catch (error) {
        console.log('Swap error', error);
        setTxStatus((prev) => ({ txid: '', status: 'fail', quotedDynamicSlippageBps: prev?.quotedDynamicSlippageBps }));
        setLastSwapResult({ swapResult, quoteResponseMeta });
      }
    },
    [quoteResponseMeta],
  );

  const onRequestIx = useCallback(async (): Promise<IOnRequestIxCallback> => {
    if (!walletPublicKey || !wallet?.adapter) throw new Error('Missing wallet');
    if (!quoteResponseMeta) throw new Error('Missing quote');

    const inputMint = quoteResponseMeta?.quoteResponse.inputMint;
    const outputMint = quoteResponseMeta?.quoteResponse.outputMint;

    // A direct reference from https://station.jup.ag/docs/apis/swap-api#instructions-instead-of-transaction
    const instructions: IOnRequestIxCallback['instructions'] = await (
      await fetch('https://quote-api.jup.ag/v6/swap-instructions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          quoteResponse: quoteResponseMeta.original,
          userPublicKey: walletPublicKey,
          dynamicComputeUnitLimit: true,
        }),
      })
    ).json();

    if (!instructions || instructions.error) {
      setErrors({
        'missing-instructions': {
          title: 'Missing instructions',
          message: 'Failed to get swap instructions',
        },
      });

      console.log('Failed to get swap instructions: ', instructions);
      throw new Error('Failed to get swap instructions');
    }

    const [sourceAddress, destinationAddress] = [inputMint, outputMint].map((mint) =>
      getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(walletPublicKey)),
    );

    return {
      meta: {
        sourceAddress,
        destinationAddress,
        quoteResponseMeta,
      },
      instructions,
      onSubmitWithIx,
    };
  }, [walletPublicKey, wallet?.adapter, quoteResponseMeta, onSubmitWithIx]);

  const executeTransaction = useExecuteTransaction();
  const onSubmit = useCallback(async () => {
    if (!walletPublicKey || !wallet?.adapter || !quoteResponseMeta) {
      return null;
    }

    let intervalId: NodeJS.Timer | undefined;

    const swapResult = new Promise<SwapResult | null>(async (res, rej) => {
      if (!wallet.adapter.publicKey) return null;

      setTxStatus({
        txid: '',
        status: 'loading',
        quotedDynamicSlippageBps: '',
      });

      const swapTransactionResponse = await fetchSwapTransaction({
        quoteResponseMeta,
        userPublicKey: wallet.adapter.publicKey,
        prioritizationFeeLamports: 1, // 1 is meaningless, since we append the fees ourself in executeTransaction
        wrapUnwrapSOL: true,
        allowOptimizedWrappedSolTokenAccount: false,
        dynamicSlippage: form.userSlippageMode === 'DYNAMIC' ? { maxBps: form.dynamicSlippageBps } : undefined,
      });

      if ('error' in swapTransactionResponse) {
        console.error('Error in swapTransactionResponse', swapTransactionResponse.error);
      } else {
        modifyComputeUnitPriceAndLimit(swapTransactionResponse.swapTransaction, {
          referenceFee: (() => {
            if (!referenceFees?.jup.m || !referenceFees?.jup.h || !referenceFees?.jup.vh) {
              return referenceFees?.swapFee;
            }

            if (priorityLevel === 'MEDIUM') return referenceFees.jup.m;
            if (priorityLevel === 'HIGH') return referenceFees.jup.h;
            if (priorityLevel === 'VERY_HIGH') return referenceFees.jup.vh;
          })(),
        });

        const { inputMint, outputMint } = quoteResponseMeta.quoteResponse;
        const { destinationAddress, sourceAddress } = await fetchSourceAddressAndDestinationAddress({
          connection,
          inputMint,
          outputMint,
          userPublicKey: wallet.adapter.publicKey!,
        });

        const result = await executeTransaction(
          swapTransactionResponse.swapTransaction,
          {
            blockhash: swapTransactionResponse.blockhash,
            lastValidBlockHeight: swapTransactionResponse.lastValidBlockHeight,
            skipPreflight: true,
          },
          {
            onPending: () => {
              setTxStatus({
                txid: '',
                status: 'pending-approval',
                quotedDynamicSlippageBps: swapTransactionResponse.dynamicSlippageReport?.slippageBps?.toString(),
              });
            },
            onSending: () => {
              setTxStatus({
                txid: '',
                status: 'sending',
                quotedDynamicSlippageBps: swapTransactionResponse.dynamicSlippageReport?.slippageBps?.toString(),
              });
            },
            onProcessed: () => {
              // Not using processed for now
            },
            onSuccess: (txid, transactionResponse) => {
              setTxStatus({
                txid,
                status: 'success',
                quotedDynamicSlippageBps: swapTransactionResponse.dynamicSlippageReport?.slippageBps?.toString(),
              });

              const [sourceTokenBalanceChange, destinationTokenBalanceChange] =
                getTokenBalanceChangesFromTransactionResponse({
                  txid,
                  inputMint,
                  outputMint,
                  user: wallet.adapter.publicKey!,
                  sourceAddress,
                  destinationAddress,
                  transactionResponse,
                  hasWrappedSOL: false,
                });

              setLastSwapResult({
                swapResult: {
                  txid,
                  inputAddress: inputMint,
                  outputAddress: outputMint,
                  inputAmount: sourceTokenBalanceChange,
                  outputAmount: destinationTokenBalanceChange,
                },
                quoteResponseMeta: quoteResponseMeta,
              });

              return res({
                txid,
                inputAddress: inputMint,
                outputAddress: outputMint,
                inputAmount: sourceTokenBalanceChange,
                outputAmount: destinationTokenBalanceChange,
              });
            },
          },
        );

        if ('transactionResponse' in result === false) {
          console.log(result);

          setLastSwapResult({
            swapResult: {
              error: 'error' in result ? result.error : undefined,
            },
            quoteResponseMeta: quoteResponseMeta,
          });

          setTxStatus({
            txid: result.txid || '',
            status: 'error' in result && result.error?.message.includes('expired') ? 'timeout' : 'fail',
            quotedDynamicSlippageBps: swapTransactionResponse.dynamicSlippageReport?.slippageBps?.toString(),
          });

          return rej(null);
        }
      }
    })
      .catch((result: SwapResult) => {
        console.log(result);
        return null;
      })
      .finally(() => {
        if (intervalId) {
          clearInterval(intervalId);
        }
      });

    return swapResult;
  }, [
    walletPublicKey,
    wallet?.adapter,
    quoteResponseMeta,
    fetchSwapTransaction,
    form.userSlippageMode,
    form.dynamicSlippageBps,
    modifyComputeUnitPriceAndLimit,
    connection,
    executeTransaction,
    referenceFees?.jup.m,
    referenceFees?.jup.h,
    referenceFees?.jup.vh,
    referenceFees?.swapFee,
    priorityLevel,
  ]);

  const reset = useCallback(
    ({ resetValues } = { resetValues: false }) => {
      if (resetValues) {
        setForm(INITIAL_FORM);
        setupInitialAmount();
      } else {
        setForm((prev) => ({ ...prev, toValue: '' }));
      }

      setQuoteResponseMeta(null);
      setErrors({});
      setLastSwapResult(null);
      setTxStatus(undefined);
      refreshAccount();
    },
    [refreshAccount, setupInitialAmount],
  );

  // onFormUpdate callback
  useEffect(() => {
    if (typeof window.Jupiter.onFormUpdate === 'function') {
      window.Jupiter.onFormUpdate(form);
    }
  }, [form]);

  // onFormUpdate callback
  useEffect(() => {
    if (typeof window.Jupiter.onScreenUpdate === 'function') {
      window.Jupiter.onScreenUpdate(screen);
    }
  }, [screen]);

  return (
    <SwapContext.Provider
      value={{
        form,
        setForm,
        isToPairFocused,
        errors,
        setErrors,
        fromTokenInfo,
        toTokenInfo,
        quoteResponseMeta,
        setQuoteResponseMeta,
        onSubmit,
        onRequestIx,
        lastSwapResult,
        reset,

        displayMode,
        formProps,
        scriptDomain,
        swapping: {
          txStatus,
        },
        jupiter: {
          asLegacyTransaction,
          setAsLegacyTransaction,
          quoteResponseMeta,
          loading,
          refresh,
          error,
          lastRefreshTimestamp,
        },
        setUserSlippage,
        setUserSlippageDynamic,
        setUserSlippageMode,
      }}
    >
      {children}
    </SwapContext.Provider>
  );
};
