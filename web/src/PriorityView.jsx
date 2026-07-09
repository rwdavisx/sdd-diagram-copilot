import { useEffect, useState } from 'react';

export default function PriorityView({ items, selectedId, onSelect }) {
  const [data, setData] = useState(null);

  // Refetch whenever project data changes (items is fresh on every reload).
  useEffect(() => {
    let stale = false;
    fetch('/api/priority')
      .then((r) => r.json())
      .then((d) => { if (!stale) setData(d); })
      .catch(() => { if (!stale) setData(null); });
    return () => { stale = true; };
  }, [items]);

  if (!data) return <div className="loading">Loading…</div>;

  return (
    <div className="priority">
      {data.warnings.length > 0 && (
        <div className="errors"><ul>{data.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
      )}
      <ol className="priority-list">
        {data.items.map((item) => (
          <li key={item.id}>
            <button
              className={`card status-${item.status} ${item.id === selectedId ? 'selected' : ''}`}
              onClick={() => onSelect(item.id)}
            >
              <div className="card-name">{item.name}</div>
              <div className="card-meta">
                <span className={`badge type-${item.type}`}>{item.type}</span>
                {item.spec ? <span className="spec-flag">spec</span>
                  : <span className="spec-flag missing">no spec</span>}
                {item.ready
                  ? <span className="ready-flag">ready{item.dependents > 0 ? ` · unblocks ${item.dependents}` : ''}</span>
                  : <span className="blocked-flag">blocked by: {item.blockedBy.join(', ')}</span>}
                {item.cycle && <span className="blocked-flag">dependency cycle</span>}
              </div>
            </button>
          </li>
        ))}
      </ol>
      {data.items.length === 0 && <div className="column-empty">everything is shipped</div>}
    </div>
  );
}
