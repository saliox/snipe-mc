-- Table source de vérité de l'abonnement. Écriture RÉSERVÉE au service_role
-- (le webhook Stripe) ; l'utilisateur ne peut QUE lire sa propre ligne.
create table if not exists public.subscriptions (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id     text,
  stripe_subscription_id text,
  status                 text not null default 'inactive',   -- active|trialing|past_due|canceled|unpaid|incomplete|none
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  updated_at             timestamptz not null default now()
);

create index if not exists subscriptions_customer_idx
  on public.subscriptions(stripe_customer_id);

alter table public.subscriptions enable row level security;

-- L'utilisateur lit UNIQUEMENT sa ligne. Aucune policy insert/update/delete pour
-- 'authenticated' => écritures refusées côté client. Le webhook écrit avec la clé
-- service_role, qui BYPASS la RLS.
drop policy if exists "read own subscription" on public.subscriptions;
create policy "read own subscription"
  on public.subscriptions for select
  to authenticated
  using ((select auth.uid()) = user_id);
