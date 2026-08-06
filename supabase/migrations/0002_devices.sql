-- Appareils vus par utilisateur (quota anti-partage de compte, appliqué serveur-side
-- par l'edge function subscription-status). Écriture réservée au service_role.
create table if not exists public.devices (
  user_id    uuid not null references auth.users(id) on delete cascade,
  device_fp  text not null,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  primary key (user_id, device_fp)
);

alter table public.devices enable row level security;
-- Aucune policy pour 'authenticated' => le client ne lit/écrit jamais cette table.
-- Seul le service_role (edge function) y accède (bypass RLS).
