// web/admin/deep-links.js
//
// The links on the "Get started" page, in ONE place so they are easy to change. Everything in a link comes from two trusted values:
// the shop's myshopify.com domain (from the verified session token or the pinned console shop) and the app's API key.
//
// Theme editor deep links, as Shopify documents them (shopify.dev, "Theme app extensions > Configuration > Deep linking", read on
// 2026-10-26; the installed @shopify packages do not cover them):
//   activate an app embed: https://<shop>/admin/themes/current/editor?context=apps&template=<template>&activateAppId=<api_key>/<handle>
//   add an app block:      https://<shop>/admin/themes/current/editor?template=<template>&addAppBlockId=<api_key>/<handle>&target=newAppsSection
// <api_key> is the app's client id ("uuid" there is deprecated); <handle> is the block's Liquid file name without ".liquid".
// NOT confirmed on a real store from here: Shopify's developer forum has reports of these links opening the editor without selecting
// the block (the editor then still offers it under "App embeds" / "Add section > Apps"). The page says so next to the links.

/** The handles of the two blocks in extensions/rewards-widget/blocks/. */
export const BLOCK_HANDLES = { embed: 'rewards-widget', page: 'rewards-page' };

/** The page the widget links to by default (its "Rewards page URL" setting). */
export const REWARDS_PAGE_PATH = '/pages/rewards';

const SHOP = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;

/** @returns {{ activateEmbed: string, newPage: string, addPageBlock: string, storefrontPage: string }} */
export function deepLinks({ shop, apiKey }) {
  if (!SHOP.test(String(shop))) throw new Error('deepLinks: not a myshopify.com domain');
  const key = encodeURIComponent(String(apiKey ?? ''));
  const editor = `https://${shop}/admin/themes/current/editor`;
  return {
    activateEmbed: `${editor}?context=apps&template=index&activateAppId=${key}/${BLOCK_HANDLES.embed}`,
    newPage: `https://${shop}/admin/pages/new`,
    addPageBlock: `${editor}?template=page&addAppBlockId=${key}/${BLOCK_HANDLES.page}&target=newAppsSection`,
    storefrontPage: `https://${shop}${REWARDS_PAGE_PATH}`,
  };
}
