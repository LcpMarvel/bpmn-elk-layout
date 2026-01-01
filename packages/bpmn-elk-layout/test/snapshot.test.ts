import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BpmnElkLayout } from '../src/converter';
import { readdirSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { renderBpmnToPng, initBrowser, closeBrowser } from './helpers/bpmn-renderer';

const FIXTURES_DIR = join(__dirname, 'fixtures');
const SCREENSHOTS_DIR = join(__dirname, '__screenshots__');
const SNAPSHOTS_DIR = join(__dirname, '__snapshots__');

// 动态读取 fixtures 目录下的所有 .json 文件
function getFixtureFiles(): string[] {
  try {
    return readdirSync(FIXTURES_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

describe('BPMN XML Snapshots', () => {
  const files = getFixtureFiles();

  if (files.length === 0) {
    it.skip('no fixture files found', () => {});
    return;
  }

  // Ensure output directories exist
  if (!existsSync(SCREENSHOTS_DIR)) {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
  if (!existsSync(SNAPSHOTS_DIR)) {
    mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }

  beforeAll(async () => {
    await initBrowser();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  const converter = new BpmnElkLayout();

  for (const file of files) {
    it(`should match snapshot for ${file}`, async () => {
      const filePath = join(FIXTURES_DIR, file);
      const input = JSON.parse(readFileSync(filePath, 'utf-8'));
      const xml = await converter.to_bpmn(input);

      // 1. XML snapshot test - 每个 fixture 独立的快照文件
      const snapName = file.replace('.json', '.bpmn');
      const snapPath = join(SNAPSHOTS_DIR, snapName);
      await expect(xml).toMatchFileSnapshot(snapPath);

      // 2. Render to PNG
      const pngName = file.replace('.json', '.png');
      const pngPath = join(SCREENSHOTS_DIR, pngName);
      await renderBpmnToPng(xml, pngPath);
    });
  }
});
