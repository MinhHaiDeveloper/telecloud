import React from 'react';
import { t } from '../i18n';

// Renders the steps produced by computeSignalPath(); the EQ step doubles as a toggle, and a step
// whose processing pushes the sound over 0 dBFS blinks red
const SignalPathSteps = ({ signal, eqEnabled, setEqEnabled, onOpenEq }) => (
  <div className="sp-steps">
    {signal.steps.map((s, i) => (
      <div key={i} className={`sp-step ${s.state === 'off' ? 'off' : s.state === 'warn' ? 'warn' : ''} ${s.clip ? 'clip' : ''}`}>
        <i />
        <span className="lbl" style={s.key === 'eq' && onOpenEq ? { cursor: 'pointer' } : undefined} onClick={s.key === 'eq' ? onOpenEq : undefined} title={s.detail || undefined}>
          {s.label}
        </span>
        {s.key === 'eq' && setEqEnabled ? (
          <label>
            {eqEnabled ? 'On' : t('Off')}
            <input type="checkbox" checked={!!eqEnabled} onChange={(e) => setEqEnabled(e.target.checked)} />
          </label>
        ) : (
          <span className="val mono">{s.value}</span>
        )}
        {s.detail && <small className="sp-detail">{s.detail}</small>}
        {s.clip && <small className="sp-detail sp-clip">{t('Clipping: lower a boost, or turn on Prevent clipping in Settings > Sound')}</small>}
      </div>
    ))}
  </div>
);

export default SignalPathSteps;
