import { useCallback, useEffect, useRef, useState } from "react";
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

/** How long a text input waits after the last key before it writes the URL. */
export const URL_INPUT_DELAY_MS = 150;

/**
 * A text input bound to one search param. The input reads local state, so
 * every key lands even when keys arrive faster than renders: the router
 * updates the URL in a transition, and an input that reads the URL directly
 * gets its old value back between two fast keys ("telegram" became "tegram").
 * The URL is written once typing pauses (`delayMs`). A change of the param
 * from elsewhere (a tab switch that resets it, back and forward) replaces the
 * local value.
 */
export function useUrlSearchInput(
  key: string,
  options: SetQueryParamOptions & { delayMs?: number } = {},
): [string, (value: string) => void] {
  const { searchParams, setParam } = useUrlSearchState();
  const { delayMs = URL_INPUT_DELAY_MS, ...paramOptions } = options;
  const urlValue = readStringParam(searchParams, key, paramOptions.defaultValue);
  const [value, setValue] = useState(urlValue);
  // The last value this input wrote (or read) from the URL.
  const synced = useRef(urlValue);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestOptions = useRef(paramOptions);
  latestOptions.current = paramOptions;

  useEffect(() => {
    if (urlValue === synced.current) return;
    synced.current = urlValue;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setValue(urlValue);
  }, [urlValue]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const change = useCallback(
    (next: string) => {
      setValue(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        synced.current = next;
        setParam(key, next, latestOptions.current);
      }, delayMs);
    },
    [key, delayMs, setParam],
  );

  return [value, change];
}
