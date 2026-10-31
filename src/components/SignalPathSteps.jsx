import React from 'react';

// Renders the steps produced by computeSignalPath(); the EQ step doubles as a toggle
const SignalPathSteps = ({ signal, eqEnabled, setEqEnabled, onOpenEq }) => (
  <div className="sp-steps">
    {signal.steps.map((s, i) => (
      <div key={i} className={`sp-step ${s.state === 'off' ? 'off' : s.state === 'warn' ? 'warn' : ''}`}>
        <i />
        <span className="lbl" style={s.key === 'eq' && onOpenEq ? { cursor: 'pointer' } : undefined} onClick={s.key === 'eq' ? onOpenEq : undefined}>
          {s.label}
        </span>
        {s.key === 'eq' && setEqEnabled ? (
          <label>
            {eqEnabled ? 'On' : 'Off'}
            <input type="checkbox" checked={!!eqEnabled} onChange={(e) => setEqEnabled(e.target.checked)} />
          </label>
        ) : (
          <span className="val mono">{s.value}</span>
        )}
      </div>
    ))}
  </div>
);

export default SignalPathSteps;
