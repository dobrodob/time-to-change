-- Seed events table из data/events.json (production).
-- На момент миграции 2026-05-12 events массив был пустой —
-- календарь событий ведётся вручную, раз в квартал заглядывая в forex calendar.
-- Эта миграция оставлена как placeholder; future migrations (0003, 0004, …)
-- будут добавлять конкретные события через INSERT.

-- Пример вставки (закомментирован, для шаблона):
-- INSERT INTO events (ts, type, description)
--   VALUES ('2026-06-12T18:00:00Z', 'FOMC', 'FOMC rate decision');
