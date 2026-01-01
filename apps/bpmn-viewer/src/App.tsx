import { useState, useCallback } from 'react';
import { BpmnViewer } from './components/BpmnViewer';
import { XmlInput } from './components/XmlInput';
import { JsonInput } from './components/JsonInput';
import { ErrorDisplay } from './components/ErrorDisplay';

type InputMode = 'xml' | 'json';

export default function App() {
  const [xml, setXml] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<InputMode>('xml');
  const [isLoading, setIsLoading] = useState(false);

  const handleXmlChange = useCallback((newXml: string) => {
    setXml(newXml);
    setError(null);
  }, []);

  const handleError = useCallback((newError: string | null) => {
    setError(newError);
  }, []);

  const handleModeChange = useCallback((mode: InputMode) => {
    setInputMode(mode);
    setError(null);
  }, []);

  const handleClear = useCallback(() => {
    setXml('');
    setError(null);
  }, []);

  const [copied, setCopied] = useState(false);

  const handleCopyXml = useCallback(async () => {
    if (!xml) return;
    try {
      await navigator.clipboard.writeText(xml);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy XML:', err);
    }
  }, [xml]);

  return (
    <div className="app">
      <header className="header">
        <h1>BPMN Viewer - Test Frontend</h1>
        <div className="header-actions">
          {xml && (
            <button
              className="btn btn-primary"
              onClick={handleCopyXml}
              title="Copy BPMN XML to clipboard"
            >
              {copied ? 'Copied!' : 'Copy XML'}
            </button>
          )}
          <button className="btn btn-secondary" onClick={handleClear}>
            Clear
          </button>
        </div>
      </header>

      <main className="main">
        <div className="input-panel">
          <div className="tabs">
            <button
              className={`tab ${inputMode === 'xml' ? 'active' : ''}`}
              onClick={() => handleModeChange('xml')}
            >
              BPMN XML
            </button>
            <button
              className={`tab ${inputMode === 'json' ? 'active' : ''}`}
              onClick={() => handleModeChange('json')}
            >
              ELK-BPMN JSON
            </button>
          </div>

          <div className="input-content">
            {inputMode === 'xml' ? (
              <XmlInput
                onXmlChange={handleXmlChange}
                onError={handleError}
              />
            ) : (
              <JsonInput
                onXmlChange={handleXmlChange}
                onError={handleError}
                onLoadingChange={setIsLoading}
              />
            )}
          </div>
        </div>

        <div className="viewer-panel">
          {error ? (
            <ErrorDisplay error={error} />
          ) : isLoading ? (
            <div className="loading">Converting and layouting...</div>
          ) : xml ? (
            <BpmnViewer xml={xml} onError={handleError} />
          ) : (
            <div className="placeholder">
              <div className="placeholder-icon">📊</div>
              <h2>No BPMN diagram loaded</h2>
              <p>
                {inputMode === 'xml'
                  ? 'Paste BPMN XML or upload a .bpmn file to view'
                  : 'Paste ELK-BPMN JSON to convert and view'}
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
