import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

export type QueryParamValue = boolean | number | string | null | undefined;

export interface SetQueryParamOptions {
  defaultValue?: string;
  replace?: boolean;
  reset?: string[];
}

export interface SetQueryParamsOptions {
  defaultValues?: Record<string, string>;
  replace?: boolean;
  reset?: string[];
}

function normalizeQueryParamValue(value: QueryParamValue): string {
  if (value == null) return "";
  return String(value);
}

function setOrDeleteParam(
  params: URLSearchParams,
  key: string,
  value: QueryParamValue,
  defaultValue = "",
) {
  const normalized = normalizeQueryParamValue(value);
  if (normalized === "" || normalized === defaultValue) {
    params.delete(key);
  } else {
    params.set(key, normalized);
  }
}

export function readStringParam(
  searchParams: URLSearchParams,
  key: string,
  defaultValue = "",
): string {
  return searchParams.get(key) ?? defaultValue;
}

export function readBooleanParam(
  searchParams: URLSearchParams,
  key: string,
  defaultValue = false,
): boolean {
  const value = searchParams.get(key);
  if (value == null) return defaultValue;
  return value === "true";
}

export function readNumberParam(
  searchParams: URLSearchParams,
  key: string,
  defaultValue: number,
  options: { allowed?: readonly number[]; min?: number } = {},
): number {
  const value = Number(searchParams.get(key));
  if (!Number.isFinite(value)) return defaultValue;
  if (options.min != null && value < options.min) return defaultValue;
  if (options.allowed && !options.allowed.includes(value)) return defaultValue;
  return value;
}

export function useUrlSearchState() {
  const [searchParams, setSearchParams] = useSearchParams();

  const setParam = useCallback(
    (key: string, value: QueryParamValue, options: SetQueryParamOptions = {}) => {
      const { defaultValue = "", replace = true, reset = [] } = options;
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          setOrDeleteParam(next, key, value, defaultValue);
          for (const resetKey of reset) next.delete(resetKey);
          return next;
        },
        { replace },
      );
    },
    [setSearchParams],
  );

  const setParams = useCallback(
    (updates: Record<string, QueryParamValue>, options: SetQueryParamsOptions = {}) => {
      const { defaultValues = {}, replace = true, reset = [] } = options;
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(updates)) {
            setOrDeleteParam(next, key, value, defaultValues[key] ?? "");
          }
          for (const resetKey of reset) next.delete(resetKey);
          return next;
        },
        { replace },
      );
    },
    [setSearchParams],
  );

  return { searchParams, setParam, setParams };
}
