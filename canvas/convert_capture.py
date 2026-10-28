import contextlib
import io
import json
import os
import re
import sys
from urllib.parse import parse_qs, urlsplit
from markitdown import MarkItDown, StreamInfo

with open(sys.argv[1], 'rb') as source:
    html = source.read()
url = sys.argv[2]
parsed = urlsplit(url)
video_id = None
if parsed.hostname in {'youtube.com', 'www.youtube.com', 'm.youtube.com'}:
    parts = parsed.path.strip('/').split('/')
    if parts == ['watch']:
        video_id = parse_qs(parsed.query).get('v', [None])[0]
    elif len(parts) == 2 and parts[0] in {'shorts', 'embed'}:
        video_id = parts[1]
elif parsed.hostname in {'youtu.be', 'www.youtu.be'}:
    video_id = parsed.path.strip('/')
is_video = bool(video_id and re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id))

converter = MarkItDown(enable_plugins=False)
with contextlib.redirect_stdout(sys.stderr):
    page = converter.convert_stream(io.BytesIO(html), stream_info=StreamInfo(mimetype='text/html')).text_content or ''
    markdown = page
    caption_status = 'not_applicable'
    if is_video:
        try:
            video = converter.convert_stream(io.BytesIO(html), stream_info=StreamInfo(mimetype='text/html', url=url)).text_content or ''
            _, marker, transcript = video.partition('\n### Transcript\n')
            if marker and transcript.strip():
                markdown = '# YouTube transcript\n\n' + transcript.strip() + '\n\n---\n\n# Captured page\n\n' + page
                caption_status = 'available'
            else:
                caption_status = 'unavailable'
        except Exception as error:
            print(f'YouTube caption retrieval failed: {type(error).__name__}', file=sys.stderr)
            caption_status = 'unavailable'
        if caption_status == 'unavailable':
            markdown = '> YouTube captions could not be retrieved. This capture contains the page only.\n\n' + page
print(json.dumps({'markdown': markdown, 'caption_status': caption_status, 'python': os.path.abspath(sys.executable), 'real_python': os.path.realpath(sys.executable), 'prefix': sys.prefix, 'path': sys.path}, ensure_ascii=False))
