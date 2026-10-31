import React from 'react';
import { Dialog } from './ui';

// Kept for existing callers; renders the shared themed dialog
const Modal = ({ isOpen, onClose, title, children, icon = 'info' }) => (
  <Dialog open={isOpen} onClose={onClose} title={title} icon={icon} width={480}
    actions={<button className="btn-primary" onClick={onClose}>Got it</button>}>
    {children}
  </Dialog>
);

export default Modal;
