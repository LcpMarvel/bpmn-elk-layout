import { useEffect, useRef } from 'react';
import BpmnJS from 'bpmn-js';

interface BpmnViewerProps {
  xml: string;
  onError: (error: string | null) => void;
}

export function BpmnViewer({ xml, onError }: BpmnViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<BpmnJS | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create viewer instance
    viewerRef.current = new BpmnJS({
      container: containerRef.current,
    });

    return () => {
      if (viewerRef.current) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!viewerRef.current || !xml) return;

    const importXml = async () => {
      try {
        await viewerRef.current!.importXML(xml);
        onError(null);

        // Fit diagram to viewport
        const canvas = viewerRef.current!.get('canvas') as any;
        canvas.zoom('fit-viewport');
      } catch (err: any) {
        console.error('Failed to import BPMN:', err);
        onError(err.message || 'Failed to import BPMN diagram');
      }
    };

    importXml();
  }, [xml, onError]);

  return <div ref={containerRef} className="bpmn-canvas" />;
}
