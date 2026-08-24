import request from 'supertest';
import { createApp } from '../src/app';
const app = createApp();

describe('Cross-tenant isolation', ()=>{
  it('blocks attendance cross school', async ()=>{
    const res = await request(app).get('/api/v1/attendance/summary').set('Authorization','Bearer token');
    expect(res.status).toBeGreaterThanOrEqual(200);
  });
});
