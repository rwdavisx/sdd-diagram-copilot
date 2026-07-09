import { useCallback, useEffect, useState } from 'react';
import DiagramView from './DiagramView.jsx';
import BoardView from './BoardView.jsx';
import PriorityView from './PriorityView.jsx';
import DetailPanel from './DetailPanel.jsx';
import './App.css';

const STATUSES = ['planned', 'in-progress', 'shipped'];

export default function App() {
  const [data, setData] = useState(null);
  const [view, setView] = useState('diagram');
  const [selectedId, setSelectedId] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const refetch = useCallback(() => {
    fetch('/api/project')
      .then((r) => r.json())
      .then((d) => { setData(d); setLoadError(null); })
      .catch((e) => setLoadError(String(e)));
  }, []);

  useEffect(() => {
    refetch();
    const es = new EventSource('/api/events');
    es.addEventListener('reload', refetch);
    return () => es.close();
  }, [refetch]);

  if (loadError) return <div className="fatal">Cannot reach server: {loadError}</div>;
  if (!data) return <div className="fatal">Loading…</div>;

  const items = data.items.filter((i) => i && i.id);
  const selected = items.find((i) => i.id === selectedId) || null;
  const counts = STATUSES.map((s) => [s, items.filter((i) => i.status === s).length]);

  return (
    <div className="app">
      <header>
        <h1>{data.project || 'Untitled project'}</h1>
        <div className="counts">
          {counts.map(([s, n]) => (
            <span key={s} className={`count status-${s}`}>{n} {s}</span>
          ))}
        </div>
        <div className="toggle">
          <button className={view === 'diagram' ? 'active' : ''} onClick={() => setView('diagram')}>Diagram</button>
          <button className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}>Board</button>
          <button className={view === 'priority' ? 'active' : ''} onClick={() => setView('priority')}>Priority</button>
        </div>
      </header>

      {data.errors.length > 0 && (
        <div className="errors">
          <strong>project.yaml has {data.errors.length} problem{data.errors.length > 1 ? 's' : ''}:</strong>
          <ul>{data.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}

      <main>
        {view === 'diagram' && <DiagramView items={items} selectedId={selectedId} onSelect={setSelectedId} />}
        {view === 'board' && <BoardView items={items} selectedId={selectedId} onSelect={setSelectedId} />}
        {view === 'priority' && <PriorityView items={items} selectedId={selectedId} onSelect={setSelectedId} />}
        {selected && (
          <DetailPanel item={selected} items={items} onSelect={setSelectedId} onClose={() => setSelectedId(null)} />
        )}
      </main>
    </div>
  );
}
