-- 0006: реклассификация драгметаллов в commodity.
--
-- Баг: classify() роняла TwelveData "Precious Metal" в дефолтный stock_us, из-за
-- чего XAG/USD получал чужой эмодзи (🇺🇸), часы NYSE вместо forex и неверные
-- веса скоринга. Чиним type → commodity для всех метал-символов.
--
-- ВАЖНО — НЕ трогаем provider и НЕ расширяем provider CHECK. Драгметаллы фетчатся
-- через Yahoo роутингом по символу (getProviderForAsset), а не по stored provider.
-- Расширение CHECK потребовало бы rebuild таблицы assets (DROP+recreate), а DROP
-- каскадит DELETE по FK и СНОСИТ все subscriptions + asset_state — проверено
-- локально через `wrangler d1 migrations apply --local` (defer_foreign_keys не
-- спасает). Поэтому ограничиваемся безопасным UPDATE type.
--
-- type CHECK уже допускает 'commodity' (см. 0003), так что rebuild не нужен.
-- Идемпотентно: `type != 'commodity'` guard.

UPDATE assets SET type = 'commodity'
  WHERE symbol IN ('XAG/USD', 'XAU/USD', 'XPT/USD', 'XPD/USD')
    AND type != 'commodity';
