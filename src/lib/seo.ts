/**
 * Metadados de SEO e JSON-LD. Cada página monta um `SeoProps` e o BaseLayout
 * renderiza as metas (título, canonical, Open Graph, Twitter) e um único @graph.
 */
import site from "../../site.config.ts";
import type { ImageRef } from "./config-schema.ts";
import type { PostView } from "./posts.ts";
import { absoluteUrl } from "./format.ts";
import { readMediaMeta } from "../../shared/media.ts";

type Json = Record<string, unknown>;

export interface SeoProps {
  title: string;
  description: string;
  /** Caminho canônico, ex.: /roteiros/ */
  path: string;
  image?: ImageRef;
  type?: "website" | "article";
  article?: { published: Date; modified: Date; section: string; tags: string[]; author: string };
  noindex?: boolean;
  prev?: string;
  next?: string;
  /** Nós extras do @graph (além de WebSite e Organization). */
  graph?: Json[];
}

const ids = {
  website: `${site.url}/#website`,
  organization: `${site.url}/#organization`,
  person: (id: string) => `${site.url}/#/person/${id}`,
};

export function baseGraph(): Json[] {
  const sameAs = Object.values(site.social ?? {}).filter(Boolean);
  return [
    {
      "@type": "WebSite",
      "@id": ids.website,
      url: `${site.url}/`,
      name: site.name,
      description: site.description,
      inLanguage: site.lang,
      publisher: { "@id": ids.organization },
      potentialAction: {
        "@type": "SearchAction",
        target: { "@type": "EntryPoint", urlTemplate: `${site.url}/search/?q={search_term_string}` },
        "query-input": "required name=search_term_string",
      },
    },
    {
      "@type": "Organization",
      "@id": ids.organization,
      name: site.name,
      url: `${site.url}/`,
      logo: {
        "@type": "ImageObject",
        url: absoluteUrl(site.seo.organizationLogo.src),
        width: site.seo.organizationLogo.width,
        height: site.seo.organizationLogo.height,
      },
      ...(sameAs.length ? { sameAs } : {}),
    },
  ];
}

export const breadcrumbRef = (path: string) => ({ "@id": `${absoluteUrl(path)}#breadcrumb` });

export function breadcrumb(path: string, items: { name: string; path: string }[]): Json {
  return {
    "@type": "BreadcrumbList",
    "@id": `${absoluteUrl(path)}#breadcrumb`,
    itemListElement: [{ name: "Início", path: "/" }, ...items].map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: absoluteUrl(it.path),
    })),
  };
}

export function webPage(path: string, name: string, description: string, type = "WebPage", extra: Json = {}): Json {
  const url = absoluteUrl(path);
  return {
    "@type": type,
    "@id": `${url}#webpage`,
    url,
    name,
    description,
    inLanguage: site.lang,
    isPartOf: { "@id": ids.website },
    ...extra,
  };
}

/** Imagem Open Graph da capa (1200×630 gerada junto com as variantes). */
export function coverImage(post: PostView): ImageRef | undefined {
  const cover = post.entry.data.cover;
  if (!cover) return undefined;
  const meta = readMediaMeta(cover.src);
  return meta
    ? { src: meta.og, width: 1200, height: 630, alt: cover.alt }
    : { src: cover.src, width: 1200, height: 630, alt: cover.alt };
}

export function articleSeo(post: PostView): SeoProps {
  const url = absoluteUrl(post.url);
  const image = coverImage(post);
  const coverMeta = post.entry.data.cover ? readMediaMeta(post.entry.data.cover.src) : null;
  const images = [image && absoluteUrl(image.src), coverMeta && absoluteUrl(coverMeta.src)].filter(Boolean);
  const crumbs = [
    { name: post.category.name, path: `/category/${post.category.slug}/` },
    { name: post.title, path: post.url },
  ];

  const graph: Json[] = [
    webPage(post.url, post.title, post.description, "WebPage", {
      breadcrumb: breadcrumbRef(post.url),
      datePublished: post.date.toISOString(),
      dateModified: post.updated.toISOString(),
      ...(images.length ? { primaryImageOfPage: { "@type": "ImageObject", url: images[0] } } : {}),
    }),
    breadcrumb(post.url, crumbs),
    {
      "@type": "Person",
      "@id": ids.person(post.author.id),
      name: post.author.name,
      description: post.author.bio,
      image: absoluteUrl(post.author.avatar),
      url: absoluteUrl("/sobre/"),
      ...(post.author.links ? { sameAs: Object.values(post.author.links).filter(Boolean) } : {}),
    },
    {
      "@type": "BlogPosting",
      "@id": `${url}#article`,
      headline: post.title,
      description: post.description,
      url,
      mainEntityOfPage: { "@id": `${url}#webpage` },
      isPartOf: { "@id": ids.website },
      datePublished: post.date.toISOString(),
      dateModified: post.updated.toISOString(),
      author: { "@id": ids.person(post.author.id) },
      publisher: { "@id": ids.organization },
      articleSection: post.category.name,
      ...(post.entry.data.tags.length ? { keywords: post.entry.data.tags.join(", ") } : {}),
      ...(images.length ? { image: images } : {}),
      wordCount: post.words,
      timeRequired: `PT${post.readingTime}M`,
      inLanguage: site.lang,
    },
  ];

  if (post.faq.length > 0) {
    graph.push({
      "@type": "FAQPage",
      "@id": `${url}#faq`,
      isPartOf: { "@id": `${url}#webpage` },
      mainEntity: post.faq.map((f) => ({
        "@type": "Question",
        name: f.question,
        acceptedAnswer: { "@type": "Answer", text: f.answer },
      })),
    });
  }

  return {
    title: post.title,
    description: post.description,
    path: post.url,
    image,
    type: "article",
    article: {
      published: post.date,
      modified: post.updated,
      section: post.category.name,
      tags: post.entry.data.tags,
      author: post.author.name,
    },
    graph,
  };
}

/** JSON seguro para <script type="application/ld+json">. */
export function jsonLd(graph: Json[]): string {
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
}
