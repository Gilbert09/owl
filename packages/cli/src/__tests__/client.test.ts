import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { request, ApiError } from '../client.js';

describe('cli client', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    fetchSpy.mockReset();
  });

  afterEach(() => {
    fetchSpy.mockReset();
  });

  it('unwraps ApiResponse.data on success', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: { id: 't1' } }), {
        status: 200,
      })
    );
    const data = await request<{ id: string }>('GET', '/tasks/t1', undefined, 'http://localhost:4747');
    expect(data).toEqual({ id: 't1' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:4747/api/v1/tasks/t1',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('throws ApiError when success=false', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'nope' }), { status: 400 })
    );
    await expect(
      request('POST', '/tasks', { x: 1 }, 'http://localhost:4747')
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('sends JSON body on POST', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })
    );
    await request('POST', '/tasks', { title: 'hi' }, 'http://localhost:4747');
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:4747/api/v1/tasks',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'hi' }),
      })
    );
  });
});
