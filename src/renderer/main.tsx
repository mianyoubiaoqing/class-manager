import './browser-preview-shim';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles-v2.css';

createRoot(document.getElementById('root')!).render(<App />);
