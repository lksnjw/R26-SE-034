import pathlib

path = pathlib.Path('.venv/Lib/site-packages/trl/chat_template_utils.py')
text = path.read_text(encoding='utf-8')
new_text = text.replace('.read_text()', '.read_text(encoding="utf-8")')
path.write_text(new_text, encoding='utf-8')

print("Patched successfully!")
