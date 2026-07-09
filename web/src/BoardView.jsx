const COLUMNS = [
  { status: 'planned', title: 'Planned' },
  { status: 'in-progress', title: 'In progress' },
  { status: 'shipped', title: 'Shipped' },
];

export default function BoardView({ items, selectedId, onSelect }) {
  return (
    <div className="board">
      {COLUMNS.map(({ status, title }) => {
        const cards = items.filter((i) => i.status === status);
        return (
          <div key={status} className={`column column-${status}`}>
            <h2>{title} <span className="column-count">{cards.length}</span></h2>
            {cards.map((item) => (
              <button
                key={item.id}
                className={`card status-${item.status} ${item.id === selectedId ? 'selected' : ''}`}
                onClick={() => onSelect(item.id)}
              >
                <div className="card-name">{item.name}</div>
                <div className="card-meta">
                  <span className={`badge type-${item.type}`}>{item.type}</span>
                  {item.spec ? <span className="spec-flag">spec</span>
                    : <span className="spec-flag missing">no spec</span>}
                </div>
              </button>
            ))}
            {cards.length === 0 && <div className="column-empty">nothing here</div>}
          </div>
        );
      })}
    </div>
  );
}
