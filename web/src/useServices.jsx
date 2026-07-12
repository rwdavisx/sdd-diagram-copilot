import { useEffect, useState } from 'react';
import { onServerEvent } from './useWorkflowFeed.jsx';

export const svcPost = (id, action) =>
  fetch(`/api/services/${encodeURIComponent(id)}/${action}`, { method: 'POST' });

// All service state, kept live: full refetch on every SSE `service` event.
// ponytail: refetch-on-event over delta merging; revisit if service counts grow.
export function useServices() {
  const [services, setServices] = useState([]);
  useEffect(() => {
    let stale = false;
    const refetch = () =>
      fetch('/api/services')
        .then((r) => r.json())
        .then((d) => { if (!stale) setServices(d.services || []); })
        .catch(() => {});
    refetch();
    const off = onServerEvent('service', refetch);
    const offReload = onServerEvent('reload', refetch); // run: blocks live in project.yaml
    return () => { stale = true; off(); offReload(); };
  }, []);
  return services;
}
