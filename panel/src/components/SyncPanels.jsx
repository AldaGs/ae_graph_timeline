// Read-only state and conflict decisions; all actions belong to the lifecycle.
export default function SyncPanels({ host, startup, drift, startEmptyGraph, reviewSaved, createNewComp, inspectActiveComp, keepGraph, useAeChanges }) {
  return <>
        {host.connected && startup.state !== 'ready' && (
          <div className={`ntl-startup is-${startup.state}`} role="status">
            <strong>{startup.state === 'loading' ? 'Inspecting composition' : startup.state === 'empty' ? 'No managed graph' : startup.state === 'no-comp' ? 'No active composition' : startup.state === 'comp-changed' ? 'Active composition changed' : startup.state === 'needs-decision' ? 'Recovered graph is incomplete' : 'Node Timeline is read-only'}</strong>
            <span>{startup.detail}</span>
            {startup.state === 'empty' && <button onClick={startEmptyGraph}>Start an empty graph</button>}
            {startup.state === 'needs-decision' && <button onClick={reviewSaved}>Review differences</button>}
            {startup.state === 'no-comp' && <button onClick={createNewComp}>Create New Comp…</button>}
            {startup.state === 'comp-changed' && <button onClick={inspectActiveComp}>Inspect Active Comp</button>}
          </div>
        )}
        {host.connected && startup.state === 'ready' && drift && (
          <section className="ntl-drift" role="alert" aria-label="After Effects changes">
            <strong>{drift.report.blocking.length ? 'Sync blocked' : 'After Effects changed'}</strong>
            <span>Choose which version should become the source of truth.</span>
            <div className="ntl-drift-list">
              {Object.entries(Object.groupBy
                ? Object.groupBy(drift.report.changes, (change) => change.node || 'Composition')
                : drift.report.changes.reduce((groups, change) => {
                    const key = change.node || 'Composition';
                    (groups[key] ||= []).push(change);
                    return groups;
                  }, {})).map(([node, changes]) => (
                <div key={node} className="ntl-drift-group">
                  <b>{node}</b>
                  {changes.map((change, index) => <span key={`${change.kind}:${index}`}>{change.message}</span>)}
                </div>
              ))}
            </div>
            <div className="ntl-drift-actions">
              <button onClick={keepGraph}>Keep Graph — update AE</button>
              <button onClick={useAeChanges}>Use AE Changes — update graph</button>
            </div>
          </section>
        )}
  </>;
}
