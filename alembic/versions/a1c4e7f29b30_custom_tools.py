"""custom tools (tenant-defined LLM HTTP tools)

Revision ID: a1c4e7f29b30
Revises: 16bac60983cb
Create Date: 2026-06-21 10:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'a1c4e7f29b30'
down_revision: Union[str, None] = '16bac60983cb'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'custom_tools',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('tenant_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('name', sa.String(length=64), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('parameters', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('method', sa.String(length=8), nullable=False),
        sa.Column('url', sa.Text(), nullable=False),
        sa.Column('headers_ciphertext', sa.LargeBinary(), nullable=True),
        sa.Column('headers_nonce', sa.LargeBinary(), nullable=True),
        sa.Column('timeout_seconds', sa.Integer(), server_default=sa.text('10'), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'name', name='uq_custom_tools_tenant_name'),
    )
    op.create_index('ix_custom_tools_tenant_id', 'custom_tools', ['tenant_id'])

    op.add_column(
        'agents',
        sa.Column(
            'tool_ids',
            postgresql.ARRAY(postgresql.UUID(as_uuid=True)),
            server_default=sa.text("'{}'"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column('agents', 'tool_ids')
    op.drop_index('ix_custom_tools_tenant_id', table_name='custom_tools')
    op.drop_table('custom_tools')
