// Shared astryx chips for item type, status, and spec presence.
import { Badge } from '@astryxdesign/core/Badge';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';

const TYPE_VARIANT = { frontend: 'blue', backend: 'purple', integration: 'teal' };
// planned is neutral slate app-wide (diagram borders, board columns) — not
// started is a normal state, red would read as failure.
const STATUS_VARIANT = { planned: 'neutral', 'in-progress': 'warning', shipped: 'success' };

export function TypeBadge({ type }) {
  return <Badge variant={TYPE_VARIANT[type] || 'neutral'} label={type} />;
}

export function StatusChip({ status }) {
  return (
    <>
      <StatusDot variant={STATUS_VARIANT[status] || 'neutral'} label={status} />
      <Text type="supporting" size="xsm">{status}</Text>
    </>
  );
}

const TEST_STATUS_VARIANT = { passing: 'success', failing: 'error', unknown: 'neutral' };

// Pass/fail rollup for an item's recorded tests; renders nothing when there
// are none, so nodes without tests stay clean.
export function TestChip({ tests }) {
  if (!Array.isArray(tests) || tests.length === 0) return null;
  const passing = tests.filter((t) => t.status === 'passing').length;
  const failing = tests.filter((t) => t.status === 'failing').length;
  const variant = failing > 0 ? 'error' : passing === tests.length ? 'success' : 'neutral';
  return <Badge variant={variant} label={`tests ${passing}/${tests.length}`} />;
}

// Plan-task rollup from the server-parsed plan file (checkbox counts).
// Renders nothing when no plan exists yet. Checkboxes aren't always ticked
// as work lands, so only show a fraction when someone actually ticks them;
// a shipped item's plan is simply done.
export function PlanChip({ plan, status }) {
  if (!plan) return null;
  if (status === 'shipped' || (plan.tasks > 0 && plan.done === plan.tasks)) {
    return <Badge variant="success" label="plan ✓" />;
  }
  if (plan.done > 0) return <Badge variant="blue" label={`plan ${plan.done}/${plan.tasks}`} />;
  return <Badge variant="blue" label={plan.tasks > 0 ? `plan · ${plan.tasks} tasks` : 'plan ✓'} />;
}

export function SpecFlag({ spec }) {
  return spec
    ? <Text type="supporting" size="xsm" color="accent"><span title={spec}>spec ✓</span></Text>
    : <Text type="supporting" size="xsm"><em>no spec</em></Text>;
}

const SERVICE_VARIANT = { stopped: 'neutral', starting: 'warning', running: 'success', crashed: 'error', external: 'accent' };

// Live process status for items with a run: block; nothing otherwise.
export function ServiceDot({ service, withLabel = false }) {
  if (!service) return null;
  return (
    <>
      <StatusDot variant={SERVICE_VARIANT[service.status] || 'neutral'} label={`service ${service.status}`} />
      {withLabel && <Text type="supporting" size="xsm">{service.status}</Text>}
    </>
  );
}

export { STATUS_VARIANT, TEST_STATUS_VARIANT };
