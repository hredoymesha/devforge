"""Builds fixtures that are too large to keep in the repository."""
import pathlib

FIXTURES = pathlib.Path(__file__).parent / 'fixtures'


def ensure_huge(rows=12000):
    target = FIXTURES / 'huge.html'
    if target.exists():
        return target
    body = ''.join(
        f'<div class="row r{i % 7}" data-i="{i}"><span>item {i}</span><a href="/x/{i}">x</a></div>'
        for i in range(rows)
    )
    target.write_text(
        '<!doctype html><html lang="en"><head><title>Huge</title>'
        '<style>.row{display:flex;gap:4px}</style></head>'
        f'<body><main>{body}</main></body></html>'
    )
    return target
