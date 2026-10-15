"""call tags (user-supplied key/value labels, searchable)

Revision ID: b2f5a1c7e9d4
Revises: a1c4e7f29b30
Create Date: 2026-06-30 16:10:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'b2f5a1c7e9d4'
down_revision: Union[str, None] = 'a1c4e7f29b30'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'calls',
        sa.Column(
            'tags',
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )
    # GIN index supports containment queries: tags @> '{"region":"North"}'.
    op.create_index(
        'ix_calls_tags_gin', 'calls', ['tags'], postgresql_using='gin'
    )


def downgrade() -> None:
    op.drop_index('ix_calls_tags_gin', table_name='calls')
    op.drop_column('calls', 'tags')
