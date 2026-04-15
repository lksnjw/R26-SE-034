export function formatPercent(value) {
  return `${Number(value).toFixed(1)}%`;
}

export function formatCurrency(value) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format(value);
}
