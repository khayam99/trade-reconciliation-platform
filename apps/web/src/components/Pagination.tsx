import type { PaginationMeta } from '../api/types';

const MAX_OFFSET = 10_000;

export function Pagination({
  pagination,
  onOffsetChange,
}: {
  pagination: PaginationMeta;
  onOffsetChange: (offset: number) => void;
}) {
  const { limit, offset, total } = pagination;
  const firstItem = total === 0 ? 0 : offset + 1;
  const lastItem = Math.min(offset + limit, total);
  const hasNextPage = offset + limit < total;
  const nextOffset = offset + limit;

  return (
    <div className="pagination-bar" aria-label="Table pagination">
      <p className="pagination-summary" aria-live="polite">
        {firstItem}–{lastItem} of {total}
      </p>
      <div className="pagination-actions">
        <button
          className="pagination-button"
          type="button"
          onClick={() => onOffsetChange(Math.max(0, offset - limit))}
          disabled={offset === 0}
          aria-label="Previous page"
        >
          Previous
        </button>
        <button
          className="pagination-button"
          type="button"
          onClick={() => onOffsetChange(nextOffset)}
          disabled={!hasNextPage || nextOffset > MAX_OFFSET}
          aria-label="Next page"
        >
          Next
        </button>
      </div>
      {hasNextPage && offset >= MAX_OFFSET ? (
        <p className="pagination-limit-note">The API page limit has been reached.</p>
      ) : null}
    </div>
  );
}
