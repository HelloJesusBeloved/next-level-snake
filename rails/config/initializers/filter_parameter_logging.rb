# Never log account credentials, session tokens, or deployment secrets.
# Ending snapshots are also omitted: they are private and can be large.
Rails.application.config.filter_parameters += %i[
  password password_confirmation password_digest
  token authorization secret_key_base database_password database_url
  end_state
]
