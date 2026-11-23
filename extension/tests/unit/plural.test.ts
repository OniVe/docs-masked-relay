import { describe, expect, it } from 'vitest';
import { pluralRu } from '../../src/ui/api';

const CHAT = ['чат', 'чата', 'чатов'] as const;
const TAG = ['тег', 'тега', 'тегов'] as const;
const FILE = ['файл', 'файла', 'файлов'] as const;

describe('R22-UI-1: Russian plural forms (1 / 2-4 / 5+)', () => {
  it('uses the singular for exactly one', () => {
    expect(pluralRu(1, CHAT)).toBe('чат');
    expect(pluralRu(1, TAG)).toBe('тег');
    expect(pluralRu(1, FILE)).toBe('файл');
  });

  it('uses the few form for 2-4', () => {
    for (const count of [2, 3, 4, 22, 24]) {
      expect(pluralRu(count, CHAT)).toBe('чата');
      expect(pluralRu(count, TAG)).toBe('тега');
      expect(pluralRu(count, FILE)).toBe('файла');
    }
  });

  it('uses the many form for 5+, 11-14 and zero', () => {
    for (const count of [0, 5, 10, 11, 12, 13, 14, 25, 100]) {
      expect(pluralRu(count, CHAT)).toBe('чатов');
      expect(pluralRu(count, TAG)).toBe('тегов');
      expect(pluralRu(count, FILE)).toBe('файлов');
    }
    expect(pluralRu(21, CHAT)).toBe('чат');
  });

  it('formats the restored/vault strings without a bare `1 тегов`/`1 файлов`', () => {
    expect(`Восстановлено: 1 ${pluralRu(1, TAG)}`).toBe('Восстановлено: 1 тег');
    expect(`Импортировано: 1 ${pluralRu(1, FILE)}`).toBe('Импортировано: 1 файл');
    expect(`2 ${pluralRu(2, CHAT)}`).toBe('2 чата');
  });
});
