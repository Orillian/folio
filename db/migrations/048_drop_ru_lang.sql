-- The Russian interface language is gone: the app speaks Ukrainian and English only.
-- Anyone who had picked it moves to Ukrainian, and the column accepts only what the app ships.
UPDATE users SET lang = 'uk' WHERE lang = 'ru';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_lang_check;
ALTER TABLE users ADD CONSTRAINT users_lang_check CHECK (lang IN ('uk', 'en'));
