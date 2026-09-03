'use client';

/**
 * app/home/useHomeFeeds.js  (extracted from app/page.js)
 *
 * Core data logic behind Dealvy's home feeds.
 *
 * In the live app these loaders live inline in the home page component; they are
 * grouped here into a single hook purely for readability. Behaviour is unchanged.
 *
 * Three independent feeds, each with a strict sourcing rule:
 *   - "For you"     -> the user's own recent searches + a shared static pool.
 *   - "Daily deals" -> real price drops computed from stored price history.
 *   - "Recommended" -> the social layer: products recommended by people you follow,
 *                      with a never-empty cascade so the feed always has content.
 *
 * Design rules enforced here:
 *   - "For you" and "Daily deals" draw from the same pool, so a de-dup pass keeps a
 *     product from appearing in both (deal items are removed from "For you").
 *   - No fabricated discounts: a real deal requires an actual current price below the
 *     historical maximum. Pool fillers carry no percentage, just a neutral flag.
 *
 * Table and column names are anglicised to match the rest of this showcase.
 */

import { useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';

const isValidImage = (img) => img && !img.startsWith('data:') && img.startsWith('http');

// Illustrative fallback used by "Daily deals" for a visitor with no search history yet.
const DEFAULT_DEAL_QUERIES = ['iPhone 15', 'PlayStation 5', 'MacBook Air', 'AirPods Pro', 'Nike Air Force 1'];

export function useHomeFeeds() {
  const [forYou, setForYou] = useState([]);
  const [wishlistFeed, setWishlistFeed] = useState([]);
  const [dailyDeals, setDailyDeals] = useState([]);
  const [socialFeed, setSocialFeed] = useState([]);
  const [loadingForYou, setLoadingForYou] = useState(true);
  const [loadingDeals, setLoadingDeals] = useState(true);
  const [loadingSocial, setLoadingSocial] = useState(true);

  // --- "For you": recent searches first, then the shared pool -----------------
  const loadForYouFeed = useCallback(async (userId) => {
    setLoadingForYou(true);
    try {
      // Source 1: the user's REAL recent searches (localStorage) — not a global or
      // popular query list, which is what "Daily deals" does. For each recent search
      // take the most recent matching result, not the cheapest (no deal framing here).
      let recentSearches = [];
      try { recentSearches = JSON.parse(localStorage.getItem('dealvy_recent') || '[]').slice(0, 6); } catch (e) {}

      const fromSearches = (await Promise.all(recentSearches.map(async (q) => {
        const { data } = await supabase
          .from('price_history')
          .select('title, price, price_numeric, image, product_link, source, query')
          .eq('query', q)
          .not('image', 'is', null)
          .not('product_link', 'is', null)
          .gt('price_numeric', 5)
          .ilike('image', 'http%')
          .order('created_at', { ascending: false })
          .limit(1);
        return data?.[0] ? { ...data[0], _type: 'search', _query: q } : null;
      }))).filter(Boolean).filter(p => isValidImage(p.image));

      const seen = new Set(fromSearches.map(p => p.product_link));
      let result = [...fromSearches];

      // Source 2: generic items from the shared pool — a wide buffer (24 candidates),
      // NOT capped here. The real cap happens at render time (visibleForYou), after
      // removing items already shown in "Daily deals"; otherwise the two feeds, drawing
      // from the same pool with the same ordering, cannibalise each other.
      if (result.length < 20) {
        const { data: pool } = await supabase
          .from('static_feed')
          .select('title, price, price_numeric, image, product_link, source, query')
          .not('image', 'is', null)
          .not('product_link', 'is', null)
          .ilike('image', 'http%')
          .order('updated_at', { ascending: false })
          .limit(24);
        if (pool && pool.length > 0) {
          const freshPool = pool
            .map(p => ({ ...p, _type: 'pool', _query: p.query }))
            .filter(p => {
              const key = p.product_link || p.title;
              if (!key || seen.has(key)) return false;
              seen.add(key);
              return true;
            });
          result = [...result, ...freshPool];
        }
      }

      setForYou(result);

      // Source 3: the user's saved items.
      if (userId) {
        const { data: savedItems } = await supabase
          .from('wishlist')
          .select('title, price, image, link, source')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(4);
        setWishlistFeed((savedItems || [])
          .filter(p => p.link)
          .map(p => ({ ...p, product_link: p.link, _type: 'wishlist' })));
      }
    } catch (e) { console.error('For-you feed error:', e); }
    setLoadingForYou(false);
  }, []);

  // --- "Recommended": social layer with a three-rung never-empty cascade ------
  const loadSocialFeed = useCallback(async (userId) => {
    setLoadingSocial(true);
    try {
      // Rung 1: recommendations from people the user follows (logged-in only).
      let followedIds = [];
      if (userId) {
        const { data: followsData } = await supabase
          .from('follows').select('followed_id').eq('follower_id', userId);
        followedIds = (followsData || []).map(f => f.followed_id);
      }

      let recs = [];
      if (followedIds.length > 0) {
        const { data } = await supabase
          .from('recommendations')
          .select('id, user_id, title, price, image, link, source, message, created_at')
          .in('user_id', followedIds)
          .not('image', 'is', null)
          .ilike('image', 'http%')
          .order('created_at', { ascending: false })
          .limit(10);
        recs = data || [];
      }

      // Rung 2 (never-empty top-up): not logged in, or logged in but following few /
      // with few recommendations -> fill with recommendations from the most-followed
      // accounts. At the current scale, aggregating follows client-side is fine;
      // move it to an RPC when it grows.
      if (recs.length < 6) {
        const { data: allFollows } = await supabase.from('follows').select('followed_id');
        const counts = {};
        (allFollows || []).forEach(f => { counts[f.followed_id] = (counts[f.followed_id] || 0) + 1; });
        const popularIds = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([id]) => id)
          .filter(id => id !== userId)
          .slice(0, 15);

        if (popularIds.length > 0) {
          const excluded = new Set(recs.map(r => r.id));
          const { data: popularRecs } = await supabase
            .from('recommendations')
            .select('id, user_id, title, price, image, link, source, message, created_at')
            .in('user_id', popularIds)
            .not('image', 'is', null)
            .ilike('image', 'http%')
            .order('created_at', { ascending: false })
            .limit(10);
          recs = [...recs, ...(popularRecs || []).filter(r => !excluded.has(r.id))];
        }
      }

      // Rung 3 (last never-empty step): still short after followed + popular -> pull the
      // globally most recent recommendations, without requiring the author to have any
      // followers. This covers the cold-start: a recommendation written by someone with
      // no followers yet would otherwise never be shown to anyone, even though the data
      // genuinely exists.
      if (recs.length < 6) {
        const excluded = new Set(recs.map(r => r.id));
        const { data: recentRecs } = await supabase
          .from('recommendations')
          .select('id, user_id, title, price, image, link, source, message, created_at')
          .not('image', 'is', null)
          .ilike('image', 'http%')
          .order('created_at', { ascending: false })
          .limit(10);
        recs = [...recs, ...(recentRecs || []).filter(r => !excluded.has(r.id))];
      }

      recs = recs.filter(r => r.link).slice(0, 10);

      // Merge author profiles in JS: there is no FK between recommendations and
      // profiles, so we fetch them in a second query and join client-side.
      const authorIds = [...new Set(recs.map(r => r.user_id))];
      let profileMap = {};
      if (authorIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles').select('user_id, username, avatar_url').in('user_id', authorIds);
        (profiles || []).forEach(p => { profileMap[p.user_id] = p; });
      }

      setSocialFeed(recs.map(r => ({ ...r, _profile: profileMap[r.user_id] || null })));
    } catch (e) { console.error('Social feed error:', e); }
    setLoadingSocial(false);
  }, []);

  // --- "Daily deals": real price drops from history, topped up from the pool --
  const loadDailyDeals = useCallback(async (userId) => {
    setLoadingDeals(true);
    try {
      // Choose which queries to evaluate: the user's most frequent recent searches,
      // falling back to a default set for brand-new visitors.
      let queries = [];
      if (userId) {
        const { data: myQueries } = await supabase
          .from('price_history')
          .select('query')
          .eq('user_id', userId)
          .not('query', 'is', null)
          .order('created_at', { ascending: false })
          .limit(30);
        const counts = {};
        (myQueries || []).forEach(r => { if (r.query) counts[r.query] = (counts[r.query] || 0) + 1; });
        queries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([q]) => q);
      }
      if (queries.length === 0) queries = DEFAULT_DEAL_QUERIES;

      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      // Deal criterion: a real deal is current price < historical maximum (over 30 days).
      // No rigid "5% below the weekly average" threshold. Each query is evaluated in
      // parallel with a single price_history read.
      const evaluated = await Promise.all(queries.map(async (q) => {
        const { data: history } = await supabase
          .from('price_history')
          .select('price_numeric, image, title, product_link, source, created_at')
          .eq('query', q)
          .gte('created_at', cutoff)
          .not('price_numeric', 'is', null)
          .gt('price_numeric', 5)
          .ilike('image', 'http%')
          .not('product_link', 'is', null)
          .order('created_at', { ascending: false });
        if (!history || history.length < 3) return null;

        const currentPrice = history[0].price_numeric;
        const maxPrice = Math.max(...history.map(r => r.price_numeric));
        if (currentPrice >= maxPrice) return null;

        const dropPct = ((maxPrice - currentPrice) / maxPrice) * 100;
        return {
          title: history[0].title,
          price: `${currentPrice.toFixed(2)} €`,
          price_numeric: currentPrice,
          image: history[0].image,
          product_link: history[0].product_link,
          source: history[0].source,
          drop_pct: Math.round(dropPct),
          historical_max: maxPrice,
          _query: q,
          _type: 'deal',
        };
      }));

      let deals = evaluated.filter(Boolean);
      deals.sort((a, b) => b.drop_pct - a.drop_pct);

      // Top-up from the pool: if real deals are scarce, fill from the static pool.
      // No fake percentage — these carry _type 'static' and render a neutral
      // "recommended" badge instead of a discount.
      if (deals.length < 3) {
        const { data: pool } = await supabase
          .from('static_feed')
          .select('title, price, price_numeric, image, product_link, source')
          .not('image', 'is', null)
          .not('product_link', 'is', null)
          .ilike('image', 'http%')
          .order('updated_at', { ascending: false })
          .limit(6);
        if (pool && pool.length > 0) {
          const seen = new Set(deals.map(p => p.product_link));
          const fillers = pool
            .filter(p => p.product_link && !seen.has(p.product_link))
            .map(p => ({
              title: p.title,
              price: p.price || (p.price_numeric ? `${p.price_numeric.toFixed(2)} €` : ''),
              price_numeric: p.price_numeric,
              image: p.image,
              product_link: p.product_link,
              source: p.source,
              drop_pct: null,
              historical_max: null,
              _query: null,
              _type: 'static',
            }));
          deals = [...deals, ...fillers];
        }
      }

      setDailyDeals(deals.slice(0, 6));
    } catch (e) { console.error('Daily deals error:', e); }
    setLoadingDeals(false);
  }, []);

  // De-dup: "For you" never shows a product already shown in "Daily deals".
  // Applied at render time so both feeds can independently draw from the pool.
  const dealLinks = new Set(dailyDeals.map(d => d.product_link).filter(Boolean));
  const visibleForYou = forYou
    .filter(p => !dealLinks.has(p.product_link || p.link))
    .slice(0, 7);

  return {
    // data
    visibleForYou,
    wishlistFeed,
    dailyDeals,
    socialFeed,
    // loading flags
    loadingForYou,
    loadingDeals,
    loadingSocial,
    // loaders (call these on mount / auth change)
    loadForYouFeed,
    loadDailyDeals,
    loadSocialFeed,
  };
}
