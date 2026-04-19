import { useCallback, useState } from 'react';

function readParam(key: string): string {
  return new URLSearchParams(window.location.search).get(key) ?? '';
}

function writeParam(key: string, value: string | null): void {
  const params = new URLSearchParams(window.location.search);
  if (value === null || value === '') {
    params.delete(key);
  } else {
    params.set(key, value);
  }
  const qs = params.toString();
  window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
}

export function useUrlParam(key: string): [string, (v: string | null) => void] {
  const [value, setValue] = useState(() => readParam(key));

  const set = useCallback(
    (v: string | null) => {
      setValue(v ?? '');
      writeParam(key, v);
    },
    [key],
  );

  return [value, set];
}
