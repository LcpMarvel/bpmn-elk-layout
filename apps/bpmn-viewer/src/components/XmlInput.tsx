import { useState, useCallback, ChangeEvent } from 'react';

interface XmlInputProps {
  onXmlChange: (xml: string) => void;
  onError: (error: string | null) => void;
}

export function XmlInput({ onXmlChange, onError }: XmlInputProps) {
  const [value, setValue] = useState('');

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      setValue(e.target.value);
    },
    []
  );

  const handleLoad = useCallback(() => {
    if (!value.trim()) {
      onError('Please enter BPMN XML');
      return;
    }

    // Basic XML validation
    if (!value.includes('<?xml') && !value.includes('<bpmn:definitions') && !value.includes('<definitions')) {
      onError('Invalid BPMN XML format');
      return;
    }

    onXmlChange(value);
  }, [value, onXmlChange, onError]);

  const handleFileUpload = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target?.result as string;
        setValue(content);
        onXmlChange(content);
      };
      reader.onerror = () => {
        onError('Failed to read file');
      };
      reader.readAsText(file);
    },
    [onXmlChange, onError]
  );

  return (
    <>
      <div className="textarea-wrapper">
        <textarea
          value={value}
          onChange={handleChange}
          placeholder="Paste BPMN XML here..."
          spellCheck={false}
        />
      </div>

      <div className="button-group">
        <button className="btn btn-primary" onClick={handleLoad}>
          Load XML
        </button>
      </div>

      <div className="file-upload">
        <input
          type="file"
          id="xml-file"
          accept=".bpmn,.xml"
          onChange={handleFileUpload}
        />
        <label htmlFor="xml-file">
          Drop a .bpmn or .xml file here, or click to browse
        </label>
      </div>
    </>
  );
}
