import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createSourceTools, searchSources, readSource } from '../../search/tools.mjs';

test('source search, exact reads, pagination, hidden sources and SDK handlers', async () => {
    const temp = fileURLToPath(new URL('../../.local/temp/', import.meta.url));
    await mkdir(temp, { recursive: true });
    const root = await mkdtemp(join(temp, 'source-check-'));
    const id = 'a'.repeat(32), hidden = 'b'.repeat(32), broken = 'c'.repeat(32);
    const markdown = '# Babylon rendering\nTransparent wireframes preserve visibility.\n' + 'A long transcript line. '.repeat(1000);
    try {
        for (const source of [id, hidden, broken]) {
            const dir = join(root, '.local', 'data', 'captures', source);
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, 'capture.json'), JSON.stringify({ id: source, title: 'Babylon wireframe', url: 'https://example.com/wireframe', created: '2026-10-28T00:00:00Z', omitted: 2 }));
            await writeFile(join(dir, 'note.md'), markdown);
        }
        await writeFile(join(root, '.local', 'data', 'captures', hidden, '.hidden'), 'test');
        await writeFile(join(root, '.local', 'data', 'captures', broken, 'capture.json'), '{broken');
        const result = await searchSources(root, { query: 'transparent wireframes' });
        assert.equal(result.results.length, 1);
        assert.equal(result.results[0].source_id, id);
        assert.equal(result.searched, 1);
        assert.equal(result.skipped, 1);
        assert.match(result.results[0].excerpt, /Transparent wireframes/);
        assert.equal((await searchSources(root, { query: 'nonexistentword' })).results.length, 0);
        let text = '', offset = 0;
        do {
            const page = await readSource(root, { source_id: id, offset, max_chars: 1234 });
            assert.equal(page.omitted, 2);
            assert.equal(page.url, 'https://example.com/wireframe');
            text += page.text; offset = page.next_offset;
        } while (offset !== null);
        assert.equal(text, markdown);
        await assert.rejects(readSource(root, { source_id: '../secret' }));
        await assert.rejects(readSource(root, { source_id: hidden }));
        await assert.rejects(readSource(root, { source_id: id, offset: -1 }));
        const tools = createSourceTools(root);
        assert.equal(JSON.parse(await tools[0].handler({ query: 'Babylon' })).results[0].source_id, id);
        assert.equal(JSON.parse(await tools[1].handler({ source_id: id })).start_line, 1);
        assert.deepEqual((await searchSources(join(root, 'empty'), { query: 'anything' })).results, []);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('BM25 matches reference score and sees new documents without indexing', async () => {
    const temp = fileURLToPath(new URL('../../.local/temp/', import.meta.url));
    await mkdir(temp, {recursive:true});
    const root = await mkdtemp(join(temp, 'bm25-check-'));
    async function add(id, text) {
        const dir=join(root,'.local','data','captures',id);
        await mkdir(dir,{recursive:true});
        await writeFile(join(dir,'capture.json'),JSON.stringify({id,title:'',url:'',created:'2026-10-28T00:00:00Z'}));
        await writeFile(join(dir,'note.md'),text);
    }
    try {
        await add('d'.repeat(32),'alpha alpha beta');
        await add('e'.repeat(32),'beta gamma gamma');
        const r=await searchSources(root,{query:'alpha'});
        assert.equal(r.method,'BM25');
        assert.equal(r.results[0].source_id,'d'.repeat(32));
        assert.ok(Math.abs(r.results[0].score - Math.log(2)*2*2.2/3.2)<1e-10);
        await add('f'.repeat(32),'newlycaptured');
        assert.equal((await searchSources(root,{query:'newlycaptured'})).results[0].source_id,'f'.repeat(32));
    } finally {await rm(root,{recursive:true,force:true});}
});
