declare module 'bpmn-js' {
  interface BpmnJSOptions {
    container?: HTMLElement;
    width?: string | number;
    height?: string | number;
  }

  interface Canvas {
    zoom(level: 'fit-viewport' | number): void;
  }

  interface ImportResult {
    warnings: string[];
  }

  export default class BpmnJS {
    constructor(options?: BpmnJSOptions);
    importXML(xml: string): Promise<ImportResult>;
    get(name: 'canvas'): Canvas;
    get(name: string): unknown;
    destroy(): void;
  }
}
