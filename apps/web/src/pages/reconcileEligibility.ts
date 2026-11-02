export function partitionReconciliationBatches<T extends { validRows?: unknown }>(batches: T[]) {
  const eligible: T[] = [];
  let excludedCount = 0;

  for (const batch of batches) {
    if (
      typeof batch.validRows === 'number' &&
      Number.isFinite(batch.validRows) &&
      batch.validRows > 0
    ) {
      eligible.push(batch);
    } else {
      excludedCount += 1;
    }
  }

  return { eligible, excludedCount };
}
