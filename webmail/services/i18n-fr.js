/**
 * French for the gateway's messages. Keys are the exact English text from the code;
 * {placeholders} match the parts that change. See i18n.js.
 *
 * Order matters for keys with placeholders: the first one that matches wins, so a key with
 * more fixed text comes before a more general one ("… staff (Special permissions)." before
 * "… staff ({reason}).").
 */
const FR = {
  /* ——— Sign-in and requests (server.js) ——— */
  'The server is starting. Please try again in a moment.': 'Le serveur démarre. Veuillez réessayer dans un instant.',
  'Forbidden': 'Accès refusé',
  'Invalid request': 'Requête non valide',
  'Not found': 'Introuvable',
  'Not signed in': 'Non connecté',
  'Request too large': 'Requête trop volumineuse',
  'Not allowed from the webmail': 'Non autorisé depuis la messagerie web',
  'Email and password are required.': 'L’adresse e-mail et le mot de passe sont obligatoires.',
  'Too many failed sign-in attempts. Please wait 15 minutes and try again.': 'Trop de tentatives de connexion échouées. Veuillez patienter 15 minutes, puis réessayer.',
  'Too many failed attempts. Please wait 15 minutes and try again.': 'Trop de tentatives échouées. Veuillez patienter 15 minutes, puis réessayer.',
  'Invalid mailbox credentials': 'Identifiants de boîte mail incorrects',
  'Enter the 6-digit code from your authenticator app.': 'Saisissez le code à 6 chiffres de votre application d’authentification.',
  'Enter the current 6-digit code from your authenticator app.': 'Saisissez le code à 6 chiffres affiché en ce moment par votre application d’authentification.',
  'That code is not right. Wait for a new code and try again.': 'Ce code n’est pas correct. Attendez un nouveau code et réessayez.',
  'That code was already used. Wait for the next one.': 'Ce code a déjà été utilisé. Attendez le suivant.',
  'That code is not right. Check that your app shows "{email}" and enter the current code.': 'Ce code n’est pas correct. Vérifiez que votre application affiche « {email} » et saisissez le code actuel.',
  'Mail engine is temporarily unavailable. Please try again shortly.': 'Le moteur de messagerie est momentanément indisponible. Veuillez réessayer dans quelques instants.',
  'Your session has ended. Please sign in again.': 'Votre session a expiré. Veuillez vous reconnecter.',

  /* ——— Account security (server.js, accountSecurity.js) ——— */
  'New password must be at least 12 characters.': 'Le nouveau mot de passe doit comporter au moins 12 caractères.',
  'The new password must be different from the current one.': 'Le nouveau mot de passe doit être différent de l’actuel.',
  'Your current password or the code is not right.': 'Votre mot de passe actuel ou le code n’est pas correct.',
  'Your current password is incorrect.': 'Votre mot de passe actuel est incorrect.',
  'Your password or the code is not right.': 'Votre mot de passe ou le code n’est pas correct.',
  'Your password is incorrect.': 'Votre mot de passe est incorrect.',
  'The password could not be changed.': 'Le mot de passe n’a pas pu être modifié.',
  'The change was refused': 'La modification a été refusée',
  'That code is not right. Use the current code from your authenticator app.': 'Ce code n’est pas correct. Utilisez le code actuel de votre application d’authentification.',
  'Enter your current password.': 'Saisissez votre mot de passe actuel.',
  'Start the setup again.': 'Recommencez la configuration.',
  'Two-step sign-in is already on.': 'La validation en deux étapes est déjà activée.',
  'That browser is already signed out.': 'Ce navigateur est déjà déconnecté.',
  'Choose English or French.': 'Choisissez l’anglais ou le français.',
  'That app password no longer exists.': 'Ce mot de passe d’application n’existe plus.',
  'This mailbox already has the maximum number of app passwords. Remove one in Settings → Security, then try again.': 'Cette boîte mail a déjà le nombre maximal de mots de passe d’application. Supprimez-en un dans Paramètres → Sécurité, puis réessayez.',
  'Give the app password a name, for example "Outlook on my laptop".': 'Donnez un nom au mot de passe d’application, par exemple « Outlook sur mon ordinateur portable ».',
  'That name is reserved. Please choose another.': 'Ce nom est réservé. Veuillez en choisir un autre.',

  /* ——— Sign-up (signup.js) ——— */
  'Sign-up is not open yet.': 'Les inscriptions ne sont pas encore ouvertes.',
  /* ——— Forgot password (passwordReset.js) ——— */
  'Password recovery is not open yet.': 'La récupération du mot de passe n’est pas encore ouverte.',
  'Enter a valid email address.': 'Saisissez une adresse e-mail valide.',
  'Use another address than this mailbox.': 'Utilisez une autre adresse que cette boîte mail.',
  'Confirming a recovery address is not available yet.': 'La confirmation d’une adresse de récupération n’est pas encore disponible.',
  'Save a recovery address first.': 'Enregistrez d’abord une adresse de récupération.',
  'This recovery address is already confirmed.': 'Cette adresse de récupération est déjà confirmée.',
  'Too many codes were sent. Please wait an hour and try again.': 'Trop de codes ont été envoyés. Veuillez patienter une heure et réessayer.',
  'Enter the 6-digit code from the message.': 'Saisissez le code à 6 chiffres reçu par e-mail.',
  'That code is not right, or it has expired. Send a new one.': 'Ce code est incorrect ou a expiré. Demandez-en un nouveau.',
  'The confirmation code could not be sent. Try again in a few minutes.': 'Le code de confirmation n’a pas pu être envoyé. Réessayez dans quelques minutes.',
  'Enter a new password.': 'Saisissez un nouveau mot de passe.',
  'Type your address to confirm.': 'Saisissez votre adresse pour confirmer.',
  'That credit note was not found.': 'Cet avoir est introuvable.',
  'A download of your data is already running. Wait for it to finish.': 'Un téléchargement de vos données est déjà en cours. Attendez qu’il se termine.',
  'You can download your data 3 times a day. Please try again tomorrow.': 'Vous pouvez télécharger vos données 3 fois par jour. Veuillez réessayer demain.',
  'Your mailbox could not be read. Please sign in again.': 'Votre boîte mail n’a pas pu être lue. Veuillez vous reconnecter.',
  'Administrators can’t close their own account here. Ask IRON ID support.': 'Les administrateurs ne peuvent pas fermer leur propre compte ici. Contactez le support IRON ID.',
  'This mailbox was given to you by your organisation: ask its administrator to close it.': 'Cette boîte mail vous a été fournie par votre organisation : demandez à son administrateur de la fermer.',
  'This account is managed by IRON ID staff. Ask IRON ID support.': 'Ce compte est géré par l’équipe IRON ID. Contactez le support IRON ID.',
  'Your recovery address changed meanwhile. Reload Settings and try again.': 'Votre adresse de récupération a changé entre-temps. Rechargez les paramètres et réessayez.',
  'This link has expired or was already used. Ask for a new one.': 'Ce lien a expiré ou a déjà été utilisé. Demandez-en un nouveau.',
  'Your password can’t be reset this way. Ask your administrator.': 'Votre mot de passe ne peut pas être réinitialisé de cette façon. Demandez à votre administrateur.',
  'Enter your full IRON ID address, like name@iron-id.io.': 'Saisissez votre adresse IRON ID complète, par exemple nom@iron-id.io.',
  'The security check did not work. Please run it again.': 'La vérification de sécurité n’a pas fonctionné. Veuillez la relancer.',
  'Too many requests. Please wait a few minutes and try again.': 'Trop de demandes. Veuillez patienter quelques minutes, puis réessayer.',
  'Enter your first name.': 'Saisissez votre prénom.',
  'Use 4 to 30 letters, numbers, dots, dashes or underscores for your address.': 'Votre adresse doit comporter de 4 à 30 caractères : lettres, chiffres, points, tirets ou tirets bas.',
  'That address is reserved. Choose another one.': 'Cette adresse est réservée. Choisissez-en une autre.',
  'Enter a valid recovery email address, or leave it empty.': 'Saisissez une adresse e-mail de secours valide, ou laissez le champ vide.',
  'Use an address outside IRON ID for recovery, so you can still reach it if you are locked out.': 'Utilisez une adresse hors IRON ID comme adresse de secours, pour pouvoir y accéder si vous perdez l’accès à votre compte.',
  'Please accept the Terms of Service to continue.': 'Veuillez accepter les Conditions d’utilisation pour continuer.',
  'Too many accounts were created from this network today. Please try again tomorrow.': 'Trop de comptes ont été créés depuis ce réseau aujourd’hui. Veuillez réessayer demain.',
  'Sign-up is busy right now. Please try again later.': 'Les inscriptions sont très sollicitées en ce moment. Veuillez réessayer plus tard.',
  'That address was just taken. Choose another one.': 'Cette adresse vient d’être prise. Choisissez-en une autre.',
  'Use at least 12 characters for your password.': 'Votre mot de passe doit comporter au moins 12 caractères.',
  'Use at most 128 characters for your password.': 'Votre mot de passe doit comporter au plus 128 caractères.',
  'This password is too simple. A short sentence works well.': 'Ce mot de passe est trop simple. Une courte phrase convient très bien.',
  'This password is too common. Choose another one.': 'Ce mot de passe est trop courant. Choisissez-en un autre.',
  'This password is too easy to guess. Add another word or two.': 'Ce mot de passe est trop facile à deviner. Ajoutez un ou deux mots.',
  'Don’t use your name or your address in your password.': 'N’utilisez pas votre nom ni votre adresse dans votre mot de passe.',

  /* ——— Own domains (domains.js, registrar.js) ——— */
  'Own domains are not available yet.': 'Les domaines personnalisés ne sont pas encore disponibles.',
  'Own domains are available for {domain} mailboxes.': 'Les domaines personnalisés sont disponibles pour les boîtes mail {domain}.',
  '{domain} belongs to IRON ID.': '{domain} appartient à IRON ID.',
  'This domain does not seem to exist yet (no name servers found). Check the spelling, or buy it below.': 'Ce domaine ne semble pas encore exister (aucun serveur de noms trouvé). Vérifiez l’orthographe, ou achetez-le ci-dessous.',
  'Use letters, numbers and dashes (for example: my-company).': 'Utilisez des lettres, des chiffres et des tirets (par exemple : mon-entreprise).',
  'You have already paid for this domain.': 'Vous avez déjà payé pour ce domaine.',
  'Enter the owner’s details.': 'Saisissez les coordonnées du titulaire.',
  'Fill in every required field of the owner’s details.': 'Remplissez tous les champs obligatoires des coordonnées du titulaire.',
  'Choose the country.': 'Choisissez le pays.',
  'Enter the phone number with its country code, for example +33 6 12 34 56 78.': 'Saisissez le numéro de téléphone avec l’indicatif du pays, par exemple +33 6 12 34 56 78.',
  'Enter a valid email address for the owner.': 'Saisissez une adresse e-mail valide pour le titulaire.',
  'IRON ID sells domains ending in {list}.': 'IRON ID vend des domaines se terminant par {list}.',
  '.{tld} domains need an owner in the European Union.': 'Les domaines .{tld} doivent avoir un titulaire dans l’Union européenne.',
  'Please accept the Terms of Sale to continue.': 'Veuillez accepter les Conditions générales de vente pour continuer.',
  'This domain is no longer available.': 'Ce domaine n’est plus disponible.',
  'You can renew from {n} days before the end of the year already paid.': 'Vous pouvez renouveler à partir de {n} jours avant la fin de l’année déjà payée.',
  'This domain has expired for too long to be renewed here. Contact IRON ID support.': 'Ce domaine a expiré depuis trop longtemps pour être renouvelé ici. Contactez le support IRON ID.',
  'Your mailbox was not found.': 'Votre boîte mail est introuvable.',
  'Connect and verify that domain first.': 'Connectez et vérifiez d’abord ce domaine.',
  'You can have up to {n} addresses on your own domains.': 'Vous pouvez avoir jusqu’à {n} adresses sur vos propres domaines.',
  'You already have this address.': 'Vous avez déjà cette adresse.',
  'This address is already used.': 'Cette adresse est déjà utilisée.',
  'That address was not found.': 'Cette adresse est introuvable.',
  'Buying domains is not set up yet. Please try again later.': 'L’achat de domaines n’est pas encore disponible. Veuillez réessayer plus tard.',
  'That domain was just registered by someone else.': 'Ce domaine vient d’être enregistré par quelqu’un d’autre.',

  /* ——— Payments (billing.js, adminBilling.js) ——— */
  'Payments are not set up yet. Please try again later.': 'Le paiement n’est pas encore disponible. Veuillez réessayer plus tard.',
  'That order was not found.': 'Cette commande est introuvable.',
  'Only a paid order whose delivery failed can be retried.': 'Seule une commande payée dont la livraison a échoué peut être relancée.',
  'That invoice was not found.': 'Cette facture est introuvable.',
  'VAT rate must be between 0 and 50.': 'Le taux de TVA doit être compris entre 0 et 50.',
  'List the domain endings like: fr, com, net': 'Indiquez les extensions ainsi : fr, com, net',
  'Enter a whole number between {min} and {max}.': 'Saisissez un nombre entier entre {min} et {max}.',
  'Invalid signature': 'Signature non valide',
  'Internal error': 'Erreur interne',

  /* ——— Copy of an old mailbox (migration.js) ——— */
  'Enter the server name of your old email provider, for example imap.gmail.com.': 'Saisissez le nom du serveur de votre ancien fournisseur, par exemple imap.gmail.com.',
  'That server name was not found.': 'Ce nom de serveur est introuvable.',
  'That server cannot be used.': 'Ce serveur ne peut pas être utilisé.',
  'Use port 993 (or 143 with STARTTLS).': 'Utilisez le port 993 (ou 143 avec STARTTLS).',
  'Enter the address and password of your old mailbox.': 'Saisissez l’adresse et le mot de passe de votre ancienne boîte mail.',
  'That password is too long.': 'Ce mot de passe est trop long.',
  'Copying your old emails is part of the own-domain service. Connect a domain first.': 'La copie de vos anciens e-mails fait partie du service domaine personnalisé. Connectez d’abord un domaine.',
  'A copy is already running. Wait for it to finish.': 'Une copie est déjà en cours. Attendez qu’elle se termine.',
  'You have reached the number of copies included. Contact IRON ID support.': 'Vous avez atteint le nombre de copies incluses. Contactez le support IRON ID.',
  'The old provider refused this address or password. Some providers (Gmail, Outlook) need an app password.': 'L’ancien fournisseur a refusé cette adresse ou ce mot de passe. Certains fournisseurs (Gmail, Outlook) demandent un mot de passe d’application.',
  'Could not reach the old server. Check its name and port.': 'Impossible de joindre l’ancien serveur. Vérifiez son nom et son port.',
  'Too many attempts. Please wait an hour and try again.': 'Trop de tentatives. Veuillez patienter une heure, puis réessayer.',
  'A domain bought through IRON ID can’t be removed here. Contact IRON ID support.': 'Un domaine acheté via IRON ID ne peut pas être retiré ici. Contactez le support IRON ID.',
  'That copy was not found or has already finished.': 'Cette copie est introuvable ou déjà terminée.',
  'Your IRON ID session for this copy has ended. Start the copy again.': 'Votre session IRON ID pour cette copie a expiré. Relancez la copie.',
  'Your IRON ID mailbox is full. Free some space, then start the copy again.': 'Votre boîte mail IRON ID est pleine. Libérez de l’espace, puis relancez la copie.',
  'The old provider refused the password. Start the copy again with the right one.': 'L’ancien fournisseur a refusé le mot de passe. Relancez la copie avec le bon mot de passe.',
  'The copy stopped because of a problem with the old server. Start it again: it continues where it stopped.': 'La copie s’est arrêtée à cause d’un problème avec l’ancien serveur. Relancez-la : elle reprendra là où elle s’est arrêtée.',

  /* ——— Labels (labels.js) ——— */
  'Enter a label name.': 'Saisissez un nom de libellé.',
  'You can have up to {n} labels.': 'Vous pouvez avoir jusqu’à {n} libellés.',
  'You already have a label with that name.': 'Vous avez déjà un libellé portant ce nom.',
  'That label was not found.': 'Ce libellé est introuvable.',

  /* ——— DNS (dnsCheck.js) ——— */
  'lookup failed': 'échec de la recherche DNS',

  /* ——— Admin console (adminConsole.js) ——— */
  'JSON expected': 'JSON attendu',
  'Please sign in with your mailbox.': 'Veuillez vous connecter avec votre boîte mail.',
  'This mailbox is not an administrator.': 'Cette boîte mail n’a pas les droits d’administration.',
  'The mail server could not complete this. Please try again.': 'Le serveur de messagerie n’a pas pu terminer cette opération. Veuillez réessayer.',
  'Admin access to the mail engine is not set up yet. See the setup notes (STALWART_RECOVERY_ADMIN, one deploy).': 'L’accès administrateur au moteur de messagerie n’est pas encore configuré. Consultez les notes d’installation (STALWART_RECOVERY_ADMIN, un déploiement).',
  'The gateway is not allowed to do this yet. Deploy once with STALWART_RECOVERY_ADMIN set so it can update its permissions, then remove it again.': 'La passerelle n’est pas encore autorisée à effectuer cette action. Déployez une fois avec STALWART_RECOVERY_ADMIN défini pour qu’elle puisse mettre à jour ses autorisations, puis retirez-le.',
  'Only IRON ID staff can do this.': 'Seule l’équipe IRON ID peut effectuer cette action.',

  // Input checks
  'Enter a domain name such as company.dz.': 'Saisissez un nom de domaine, par exemple entreprise.dz.',
  'Enter a full email address.': 'Saisissez une adresse e-mail complète.',
  '"{local}" can\'t be used before the @. Use letters, numbers, dots, dashes or underscores.': '« {local} » ne peut pas être utilisé avant le @. Utilisez des lettres, des chiffres, des points, des tirets ou des tirets bas.',
  'Mailboxes must be a whole number between {min} and {max}.': 'Le nombre de boîtes mail doit être un nombre entier entre {min} et {max}.',
  'Storage per mailbox (MB) must be a whole number between {min} and {max}.': 'Le stockage par boîte mail (Mo) doit être un nombre entier entre {min} et {max}.',
  'Storage (MB) must be a whole number between {min} and {max}.': 'Le stockage (Mo) doit être un nombre entier entre {min} et {max}.',
  'Days must be a whole number between {min} and {max}.': 'Le nombre de jours doit être un nombre entier entre {min} et {max}.',
  'value must be a whole number between {min} and {max}.': 'La valeur doit être un nombre entier entre {min} et {max}.',
  '{name} must be a whole number between {min} and {max}.': '{name} : saisissez un nombre entier entre {min} et {max}.',

  // Customers
  'Unknown customer.': 'Client inconnu.',
  'Unknown status.': 'Statut inconnu.',
  'Enter the customer’s name.': 'Saisissez le nom du client.',
  'The IRON ID customer cannot be suspended.': 'Le client IRON ID ne peut pas être suspendu.',
  'The IRON ID customer cannot be deleted.': 'Le client IRON ID ne peut pas être supprimé.',
  'Remove this customer’s domains first.': 'Retirez d’abord les domaines de ce client.',

  // Admins
  'Create that mailbox first: admins sign in with a mailbox on one of the organisation’s own domains.': 'Créez d’abord cette boîte mail : les administrateurs se connectent avec une boîte mail sur l’un des domaines de l’organisation.',
  'Add IRON ID staff as platform admins instead.': 'Ajoutez plutôt les membres de l’équipe IRON ID comme administrateurs de la plateforme.',
  'You cannot remove your own admin access. Ask another admin.': 'Vous ne pouvez pas retirer votre propre accès administrateur. Demandez à un autre administrateur.',
  'That admin was not found.': 'Cet administrateur est introuvable.',

  // Plans
  'That plan does not exist.': 'Cette offre n’existe pas.',
  'That plan was not found.': 'Cette offre est introuvable.',
  'Enter a plan name.': 'Saisissez un nom d’offre.',
  'Enter a valid price.': 'Saisissez un prix valide.',
  'Currency must be a 3-letter code such as DZD or EUR.': 'La devise doit être un code à 3 lettres, par exemple DZD ou EUR.',
  'Customers still use this plan. Move them to another plan first.': 'Des clients utilisent encore cette offre. Passez-les d’abord à une autre offre.',
  'The {plan} plan allows up to {n} teams. Ask IRON ID to change the plan.': 'L’offre {plan} permet jusqu’à {n} équipes. Demandez à IRON ID de changer d’offre.',
  'The {plan} plan includes {n} mailboxes, and all are in use. Ask IRON ID to change the plan.': 'L’offre {plan} comprend {n} boîtes mail, et toutes sont utilisées. Demandez à IRON ID de changer d’offre.',
  'The plan allows up to {n} MB per mailbox.': 'L’offre permet jusqu’à {n} Mo par boîte mail.',

  // Domains and DNS
  'That domain was not found.': 'Ce domaine est introuvable.',
  '{domain} addresses belong to IRON ID.': 'Les adresses {domain} appartiennent à IRON ID.',
  'This domain is already on IRON ID. If it is yours, contact IRON ID support.': 'Ce domaine est déjà sur IRON ID. S’il vous appartient, contactez le support IRON ID.',
  'This domain is already on IRON ID. Contact IRON ID support to have it assigned to you.': 'Ce domaine est déjà sur IRON ID. Contactez le support IRON ID pour qu’il vous soit attribué.',
  'Verify or remove your other new domains first (at most {n} waiting at a time).': 'Vérifiez ou retirez d’abord vos autres nouveaux domaines ({n} en attente au maximum).',
  'This domain is already verified.': 'Ce domaine est déjà vérifié.',
  'The verification record was not found yet. DNS changes can take from a few minutes to a few hours; try again later.': 'L’enregistrement de vérification est encore introuvable. Les modifications DNS peuvent prendre de quelques minutes à quelques heures ; réessayez plus tard.',
  'Verify the domain first.': 'Vérifiez d’abord le domaine.',
  'Add and verify that domain first.': 'Ajoutez et vérifiez d’abord ce domaine.',
  'Verify the domain before adding mailboxes.': 'Vérifiez le domaine avant d’ajouter des boîtes mail.',
  'Verify the domain before adding teams.': 'Vérifiez le domaine avant d’ajouter des équipes.',
  'The catch-all address must end with @{domain}.': 'L’adresse fourre-tout doit se terminer par @{domain}.',
  'Create that mailbox or team first.': 'Créez d’abord cette boîte mail ou cette équipe.',
  'Too many new keys today. Try again tomorrow.': 'Trop de nouvelles clés aujourd’hui. Réessayez demain.',
  'There are no new keys to switch to. Create new keys first.': 'Il n’y a aucune nouvelle clé vers laquelle basculer. Créez d’abord de nouvelles clés.',
  'The record {selector}._domainkey is not visible in DNS yet. Add it, wait a little, and try again.': 'L’enregistrement {selector}._domainkey n’est pas encore visible dans le DNS. Ajoutez-le, patientez un peu, puis réessayez.',
  'There are no old keys to remove.': 'Il n’y a aucune ancienne clé à retirer.',
  'Keep at least one active key.': 'Conservez au moins une clé active.',
  '{domain} cannot be removed.': '{domain} ne peut pas être retiré.',
  'Type the domain name to confirm.': 'Saisissez le nom de domaine pour confirmer.',
  'Delete this domain’s mailboxes and teams first.': 'Supprimez d’abord les boîtes mail et les équipes de ce domaine.',
  '{email} still has an alias on {domain}. Remove it first.': '{email} a encore un alias sur {domain}. Retirez-le d’abord.',

  // Mailboxes, teams, aliases
  'That mailbox was not found.': 'Cette boîte mail est introuvable.',
  'That team was not found.': 'Cette équipe est introuvable.',
  '{email} already exists.': '{email} existe déjà.',
  'Aliases must be a list of addresses.': 'Les alias doivent être une liste d’adresses.',
  'Aliases must use one of your verified domains ({email}).': 'Les alias doivent utiliser l’un de vos domaines vérifiés ({email}).',
  '{domain} is not ready yet.': '{domain} n’est pas encore prêt.',
  '{email} is already used by {owner}.': '{email} est déjà utilisé par {owner}.',
  'Members must be a list of addresses.': 'Les membres doivent être une liste d’adresses.',
  '{email} is not one of your mailboxes.': '{email} ne fait pas partie de vos boîtes mail.',
  '{email} is managed by IRON ID staff in the engine.': '{email} est géré par l’équipe IRON ID dans le moteur de messagerie.',
  '{email} is managed by IRON ID staff and can\'t be added here.': '{email} est géré par l’équipe IRON ID et ne peut pas être ajouté ici.',
  '{email} is an administrator elsewhere on IRON ID. Ask IRON ID support.': '{email} est administrateur ailleurs sur IRON ID. Contactez le support IRON ID.',
  'You cannot do this to your own mailbox from here. Use Settings → Security in the webmail.': 'Vous ne pouvez pas effectuer cette action sur votre propre boîte mail depuis cette page. Utilisez Paramètres → Sécurité dans la messagerie web.',
  'Type the mailbox address to confirm.': 'Saisissez l’adresse de la boîte mail pour confirmer.',
  'Type the team address to confirm.': 'Saisissez l’adresse de l’équipe pour confirmer.',
  'Enter a number of days.': 'Saisissez un nombre de jours.'
};

// "{email} is managed by IRON ID staff ({reason})." — the reasons from protectedReason().
const REASONS = {
  'IRON ID service account': 'compte de service IRON ID',
  'Mail engine administrator': 'administrateur du moteur de messagerie',
  'Special engine role': 'rôle spécial dans le moteur de messagerie',
  'Special permissions': 'autorisations spéciales'
};
for (const [en, fr] of Object.entries(REASONS)) {
  FR[`{email} is managed by IRON ID staff (${en}).`] = `{email} est géré par l’équipe IRON ID (${fr}).`;
}
FR['{email} is managed by IRON ID staff ({reason}).'] = '{email} est géré par l’équipe IRON ID ({reason}).';

// The same reasons shown on their own (badge on a mailbox the console can't change).
FR['IRON ID service account'] = 'Compte de service IRON ID';
FR['Mail engine administrator'] = 'Administrateur du moteur de messagerie';
FR['Special engine role'] = 'Rôle spécial dans le moteur de messagerie';
FR['Special permissions'] = 'Autorisations spéciales';

// DNS records and checks shown in the admin console (fields purpose / problem / warnings).
Object.assign(FR, {
  'Proves that you own this domain': 'Prouve que ce domaine vous appartient',
  'Delivers this domain’s mail to IRON ID': 'Achemine le courrier de ce domaine vers IRON ID',
  'Allows IRON ID to send mail for this domain (SPF)': 'Autorise IRON ID à envoyer du courrier pour ce domaine (SPF)',
  'New signing key (DKIM) — add it before switching': 'Nouvelle clé de signature (DKIM) — ajoutez-la avant de changer de clé',
  'Signs outgoing mail (DKIM)': 'Signe le courrier sortant (DKIM)',
  'Tells receivers what to do with mail that fails the checks (DMARC). Start with p=none.': 'Indique aux destinataires quoi faire du courrier qui échoue aux contrôles (DMARC). Commencez par p=none.',
  'Could not look this up right now.': 'Vérification impossible pour le moment.',
  'There is more than one SPF record. Merge them into one.': 'Il y a plusieurs enregistrements SPF. Regroupez-les en un seul.',
  'The SPF record does not allow IRON ID yet: add "mx".': 'L’enregistrement SPF n’autorise pas encore IRON ID : ajoutez « mx ».',
  'There is more than one DMARC record.': 'Il y a plusieurs enregistrements DMARC.',
  'This domain still signs mail with keys that were exposed. Create new DKIM keys and switch to them.': 'Ce domaine signe encore le courrier avec des clés qui ont été exposées. Créez de nouvelles clés DKIM et passez à celles-ci.',
  'MX, SPF and DMARC for {domain} are managed separately and are not changed from here.': 'Les enregistrements MX, SPF et DMARC de {domain} sont gérés à part et ne sont pas modifiés ici.'
});

// engineMessage() in adminConsole.js: "Could not <what>…", for each action passed to engineSet().
const ACTIONS = {
  'create the signing keys': 'créer les clés de signature',
  'add the domain to the mail server': 'ajouter le domaine au serveur de messagerie',
  'save the domain settings': 'enregistrer les paramètres du domaine',
  'switch the domain to managed keys': 'passer le domaine en clés gérées',
  'replace the earlier new keys': 'remplacer les nouvelles clés précédentes',
  'switch keys': 'changer de clés',
  'remove the old keys': 'retirer les anciennes clés',
  'remove the signing keys': 'retirer les clés de signature',
  'remove the domain': 'retirer le domaine',
  'create the mailbox': 'créer la boîte mail',
  'save the mailbox': 'enregistrer la boîte mail',
  'reset the sign-in': 'réinitialiser la connexion',
  'suspend the mailbox': 'suspendre la boîte mail',
  'restore the mailbox': 'réactiver la boîte mail',
  'clear the catch-all address': 'effacer l’adresse fourre-tout',
  'delete the mailbox': 'supprimer la boîte mail',
  'update the team members': 'mettre à jour les membres de l’équipe',
  'create the team': 'créer l’équipe',
  'save the team': 'enregistrer l’équipe',
  'delete the team': 'supprimer l’équipe',
  'save the retention rule': 'enregistrer la règle de conservation'
};
for (const [en, fr] of Object.entries(ACTIONS)) {
  const cannot = (/^[aeéiou]/i.test(fr) ? 'Impossible d’' : 'Impossible de ') + fr;
  FR[`Could not ${en}: that address or name is already in use.`] = `${cannot} : cette adresse ou ce nom est déjà utilisé.`;
  FR[`Could not ${en}: not allowed.`] = `${cannot} : action non autorisée.`;
  FR[`Could not ${en}.`] = `${cannot}.`;
  FR[`Could not ${en}: {detail}`] = `${cannot} : {detail}`; // the engine's own description
}

module.exports = FR;
