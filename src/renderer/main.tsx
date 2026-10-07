import './browser-preview-shim';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles-v2.css';
import './figma-workspace.css';
import './figma-fidelity.css';
import './guided-workflows.css';
import './floating-assistant.css';
import './features/homeroom/homeroom.css';

createRoot(document.getElementById('root')!).render(<App />);
