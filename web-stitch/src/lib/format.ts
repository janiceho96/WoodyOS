export function humanize(value: string) {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

export function compact(value: number) {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function money(value?: string | number | null) {
  const number = Number(value ?? 0);
  return number.toFixed(number < 1 ? 4 : 2);
}

type CostRecord = {
  estimated_cost_usd?: string;
  token_input?: string | number;
  token_output?: string | number;
};

export function taskCost(records: CostRecord[], digits = 4) {
  const amount = records.reduce((sum, record) => sum + Number(record.estimated_cost_usd ?? 0), 0);
  const tokens = records.reduce((sum, record) => sum + Number(record.token_input ?? 0) + Number(record.token_output ?? 0), 0);
  const available = amount > 0 || tokens === 0;
  return {
    amount,
    available,
    label: available ? `$${amount.toFixed(digits)}` : 'Pricing unavailable',
  };
}

export function duration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function relative(value: string) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}
