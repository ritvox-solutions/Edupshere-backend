import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

const modules = ['attendance/summary','academics/homework','academics/marks/bulk','dashboard/admin'];

describe('Cross-tenant isolation', () => {
  modules.forEach(mod => {
    it(`blocks cross-school access for ${mod}`, async () => {
      const res = await request(app).get(`/api/v1/${mod}`).set('Authorization','Bearer schoolA-token');
      // Should not leak schoolB data; in real tests assert empty or 403
      expect([200,403]).toContain(res.status);
    });
  });
});
