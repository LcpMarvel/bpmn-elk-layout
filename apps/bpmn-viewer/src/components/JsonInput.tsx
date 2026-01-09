import { useState, useCallback, ChangeEvent } from 'react';
import { BpmnElkLayout } from 'bpmn-elk-layout';

interface JsonInputProps {
  onXmlChange: (xml: string) => void;
  onError: (error: string | null) => void;
  onLoadingChange: (loading: boolean) => void;
}

export function JsonInput({ onXmlChange, onError, onLoadingChange }: JsonInputProps) {
  const [value, setValue] = useState('');

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      setValue(e.target.value);
    },
    []
  );

  const handleConvert = useCallback(async () => {
    if (!value.trim()) {
      onError('Please enter ELK-BPMN JSON');
      return;
    }

    try {
      onLoadingChange(true);
      onError(null);

      // Parse JSON
      const elkBpmnJson = JSON.parse(value);

      // Validate input
      if (!elkBpmnJson || typeof elkBpmnJson !== 'object') {
        onError('Invalid ELK-BPMN JSON: must be an object');
        return;
      }

      if (!elkBpmnJson.children || !Array.isArray(elkBpmnJson.children)) {
        onError('Invalid ELK-BPMN JSON: missing "children" array');
        return;
      }

      if (elkBpmnJson.children.length === 0) {
        onError('Invalid ELK-BPMN JSON: "children" array is empty. Must contain at least one process or collaboration.');
        return;
      }

      console.log('Input JSON:', elkBpmnJson);

      // Convert using bpmn-elk-layout
      const converter = new BpmnElkLayout();
      const bpmnXml = await converter.to_bpmn(elkBpmnJson);

      console.log('Generated BPMN XML:', bpmnXml);
      onXmlChange(bpmnXml);
    } catch (err: any) {
      console.error('Conversion failed:', err);
      if (err instanceof SyntaxError) {
        onError(`Invalid JSON: ${err.message}`);
      } else {
        onError(err.message || 'Failed to convert ELK-BPMN JSON');
      }
    } finally {
      onLoadingChange(false);
    }
  }, [value, onXmlChange, onError, onLoadingChange]);

  const handleFileUpload = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target?.result as string;
        setValue(content);
      };
      reader.onerror = () => {
        onError('Failed to read file');
      };
      reader.readAsText(file);
    },
    [onError]
  );

  return (
    <>
      <div className="textarea-wrapper">
        <textarea
          value={value}
          onChange={handleChange}
          placeholder="Paste ELK-BPMN JSON here..."
          spellCheck={false}
        />
      </div>

      <div className="button-group">
        <button className="btn btn-primary" onClick={handleConvert}>
          Convert & View
        </button>
      </div>

      <div className="file-upload">
        <input
          type="file"
          id="json-file"
          accept=".json"
          onChange={handleFileUpload}
        />
        <label htmlFor="json-file">
          Drop a .json file here, or click to browse
        </label>
      </div>
    </>
  );
}
