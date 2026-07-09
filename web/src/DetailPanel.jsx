import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';

export default function DetailPanel({ item, items, onSelect, onClose }) {
  const [spec, setSpec] = useState(null); // { text } | { error } | null while loading

  useEffect(() => {
    if (!item.spec) { setSpec(null); return; }
    let cancelled = false;
    setSpec(null);
    fetch(`/api/spec?path=${encodeURIComponent(item.spec)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => { if (!cancelled) setSpec({ text }); })
      .catch((e) => { if (!cancelled) setSpec({ error: e.message }); });
    return () => { cancelled = true; };
  }, [item.id, item.spec]);

  const dependents = items.filter((i) => (i.depends || []).includes(item.id));

  return (
    <aside className="detail">
      <button className="detail-close" onClick={onClose}>×</button>
      <h2>{item.name}</h2>
      <div className="detail-meta">
        <span className={`badge type-${item.type}`}>{item.type}</span>
        <span className={`badge status-badge status-${item.status}`}>{item.status}</span>
      </div>

      {item.notes && <p className="detail-notes">{item.notes}</p>}

      {(item.depends || []).length > 0 && (
        <div className="detail-links">
          <h3>Depends on</h3>
          {item.depends.map((d) => {
            const target = items.find((i) => i.id === d);
            return target
              ? <button key={d} className="link" onClick={() => onSelect(d)}>{target.name}</button>
              : <span key={d} className="link broken" title="unknown id">{d}</span>;
          })}
        </div>
      )}
      {dependents.length > 0 && (
        <div className="detail-links">
          <h3>Used by</h3>
          {dependents.map((i) => (
            <button key={i.id} className="link" onClick={() => onSelect(i.id)}>{i.name}</button>
          ))}
        </div>
      )}

      <div className="detail-spec">
        <h3>Spec {item.spec && <code>{item.spec}</code>}</h3>
        {!item.spec && <p className="spec-missing">No spec yet — this item still needs planning.</p>}
        {item.spec && spec === null && <p>Loading spec…</p>}
        {item.spec && spec?.error && <p className="spec-missing">Could not load spec: {spec.error}</p>}
        {item.spec && spec?.text != null && (
          <div className="spec-body"><Markdown>{spec.text}</Markdown></div>
        )}
      </div>
    </aside>
  );
}
